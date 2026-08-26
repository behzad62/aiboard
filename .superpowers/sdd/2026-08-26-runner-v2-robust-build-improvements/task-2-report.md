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
- Current reviewed implementation head before this report update: `88fc2458`
- Current reviewed bundle revision: `117fb39f`
- Implemented scope: every P2 packet from P2.1 through P2.6D, including all
  review-repair commits through fail-closed browser-policy profile validation
  and the property-aware, source-mapped raw credential redaction correction.
- Historical-note convention: statements in the packet-era sections below that
  say a later packet was "locked," "deferred," or "remained with the
  controller" describe that packet's boundary at the time. They are not the
  current implementation status.
- This report records implementation and evidence; it does not declare the P2
  phase outcome or replace the independent review gate.
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

## P2.4B2b Architect final-verification review

Added the semantic review boundary for a fully executed current verification
generation. Build runtime now creates one runner-owned review request only
after the validated P2.3 submission result exists, then invokes the Architect
with `final_verification_review_required`. Only that action exposes the typed
`review_final_verification` lifecycle tool. Generic prose, no-op returns, or an
ordinary task-review action cannot satisfy the generation-specific postcondition.

The Architect context already carries the exact current generation projection;
focused coverage now proves that it includes generation ID, exact target
integration revision, completed category facts, repository inspections, and
the immutable submission result. The native Architect prompt directs semantic
review of that exact state and its persisted evidence.

`review_final_verification` requires current task/generation/submission/revision
identity, a summary, and exactly one category verdict/rationale/evidence list
for build, tests, runtime smoke, and browser. Mechanically required categories
must be green and have durable evidence; explicitly N/A categories retain their
inspection rationale. Cited evidence must exactly match its submitted category
and resolve in the authoritative EvidenceStore. The runner validates these
facts mechanically while the Architect remains the authority for the semantic
`approved` or `repair_required` verdict and rationale.

The structured decision is persisted in the existing P2.4A review event and
projection, including canonical category reviews, target revision, summary,
and exact failed categories. Semantic category reordering is idempotent across
SQLite reopen; a conflicting decision is rejected. Integration advancement
invalidates the generation and preserves the obsolete review only in history,
where it cannot authorize later lifecycle work. `repair_required` records the
next packet's exact input but creates no repair task. No `complete_run` gate was
implemented.

### P2.4B2b TDD and fault evidence

The focused review file was added before production changes and first failed
0/6 at clean HEAD `66a17437`:

```text
npx tsx --test runner-v2/test/final-verification-review.test.ts
6 tests, 0 passed, 6 failed
no-op case: Missing expected rejection
other cases: Tool review_final_verification is not registered.
```

Coverage was then expanded to eight cases for explicit missing-category and
exact Architect-context assertions. A semantic category-reordering assertion
was also added red-first: it failed 0/1 after reopen because the reordered
equivalent decision was treated as different, then passed after canonicalizing
category order.

Two required fault-only injections were made and restored:

- Removing both the generic lifecycle sequence guard and the generation-
  specific review postcondition made the prose/no-op case fail 0/1 with
  `Missing expected rejection`.
- Disabling integration invalidation plus the tool/reducer revision-currency
  guards made the stale-review case fail 0/1 because the obsolete review was
  accepted (`isError: false`).

The restored focused suite passed 8/8.

### P2.4B2b validation evidence

```text
npx tsx --test runner-v2/test/final-verification-review.test.ts
8/8 passed

npx tsx --test runner-v2/test/final-verification-review.test.ts runner-v2/test/final-verification-orchestration.test.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-scheduler.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/agent-loop.test.ts runner-v2/test/native-build-manager.test.ts runner-v2/test/recovery.test.ts runner-v2/test/architect-tools.test.ts
120/120 passed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

npx eslint runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/architect-tools.ts runner-v2/src/build-runtime.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/scheduler-store.ts runner-v2/src/sqlite-scheduler-store.ts runner-v2/test/final-verification-review.test.ts runner-v2/test/final-verification-execution.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

### P2.4B2b requirement audit

| P2.4B2b requirement | Evidence | Result |
|---|---|---|
| Exact current submission/facts in Architect context | Focused context assertions and existing protected task-graph projection | Complete |
| Typed review tool only after complete submission | Build review reason, reason-scoped registration, unvalidated-submission stop | Complete |
| Current singleton/revision and four-category validation | Tool/reducer identity, completeness, and stale fault proof | Complete |
| Category semantic rationales reference durable evidence | Structured verdicts, exact per-category IDs, authoritative store validation | Complete |
| Prose/ordinary acceptance cannot approve | Generic plus review-specific postconditions and prose fault proof | Complete |
| Missing/unknown/non-green/conflicting decisions reject | Focused negative cases and reducer/store validation | Complete |
| Non-approval persists exact repair requirement | Repair decision projection with failed categories; no new tasks assertion | Complete |
| Restart/replay deduplicates one current decision | SQLite reopen, semantic reorder replay, one-event assertion | Complete |
| Obsolete review never authorizes current state | Integration invalidation and stale authorization fault proof | Complete |
| Later lifecycle work remains out of scope | No repair creation or completion gate changes | Complete |

## Packet status

P2.4B2b Architect review is complete. Repair-task creation and the P2.5
completion gate remain intentionally deferred.

## P2.4B3 repair orchestration

Added the typed Architect repair-planning boundary and fresh-generation
lifecycle. A current structured `repair_required` review now causes BuildRuntime
to invoke the Architect with `final_verification_repair_plan_required`, carrying
the exact failed categories, review rationale through the current projection,
category evidence IDs, generation ID, kernel task ID, submission ID, review ID,
and target integration revision. Only that action registers
`plan_verification_repairs`; prose and no-op returns fail the generation-specific
postcondition and cannot clear the review.

The typed action atomically creates one or more ordinary
`verification_repair` tasks. Each task persists immutable provenance for the
source generation, kernel task, submission, review, revision, assigned failed
categories, and cited evidence, together with an ordinary worker role,
dependencies, capabilities, objective, and versioned acceptance criteria. The
tool and scheduler reducer require every failed category exactly once across the
set, exact per-category evidence references, current singleton identity, a fresh
plan revision, unique task IDs, and a valid task graph. Zero-task, uncovered,
duplicate, unrelated, stale, unknown-evidence, empty-scope, invalid-criteria,
and conflicting plans reject without partial task creation. Canonical input and
generation-scoped idempotency deduplicate semantic replay across SQLite reopen.

Repair tasks remain ordinary worker-schedulable work and follow the existing
assignment, evidence, review, and integration lifecycle. Their provenance and
kind cannot be rewritten through ordinary transitions or Architect revision.
The first integrated repair advances the canonical integration revision, which
moves the obsolete verification generation, submission, and repair-required
review to audit history. Remaining repair work still schedules normally. The
existing typed final-verification planner becomes available only after all
ordinary implementation and repair tasks are terminal, and creates one fresh
generation bound to the repaired revision. Approved verification reviews never
enter repair planning. No completion gate or P2.6 cleanup/UI behavior was added.

### P2.4B3 TDD and fault evidence

The focused repair file was added before production changes and first failed
six of seven cases at clean HEAD `2d0d45e9`:

```text
npx tsx --test runner-v2/test/final-verification-repair.test.ts
7 tests, 1 passed, 6 failed
no-op case: Missing expected rejection
other cases: Tool plan_verification_repairs is not registered.
```

After the initial implementation, a provenance-mutation case was added
red-first. It failed 0/1 with `Missing expected exception`, then passed after
the task-transition and task-revision boundaries made repair provenance and
kind immutable. The ordinary-worker integration fixture was tightened to drive
a repair through assigned, running, submitted with criterion evidence, review
requested, approved, integrating, and integrated before asserting invalidation
and fresh planning.

Two required fault-only injections were made and restored:

- Removing both the generic lifecycle sequence guard and the repair-specific
  postcondition made the prose/no-op case fail 0/1 with
  `Missing expected rejection`.
- Removing duplicate-category detection and the complete failed-category set
  guard made the atomic coverage case fail 0/1 with `false !== true`.

The restored focused suite passed 8/8.

### P2.4B3 validation evidence

```text
npx tsx --test runner-v2/test/final-verification-repair.test.ts
8/8 passed

npx tsx --test runner-v2/test/final-verification-repair.test.ts runner-v2/test/final-verification-review.test.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-orchestration.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/task-scheduler.test.ts runner-v2/test/task-graph.test.ts runner-v2/test/integration-manager.test.ts runner-v2/test/recovery-smoke.test.ts
113/113 passed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

npx eslint runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/architect-tools.ts runner-v2/src/build-runtime.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/scheduler-store.ts runner-v2/src/sqlite-scheduler-store.ts runner-v2/src/task-contracts.ts runner-v2/src/task-graph.ts runner-v2/test/final-verification-repair.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

### P2.4B3 requirement audit

| P2.4B3 requirement | Evidence | Result |
|---|---|---|
| Repair-required review mandates typed planning | Build-runtime reason/tool boundary and prose fault proof | Complete |
| Exact failed review context is exposed | Focused assertions plus current generation projection | Complete |
| Atomic narrow tasks cover failures exactly once | Negative coverage cases and restored category fault proof | Complete |
| Durable exact provenance and evidence | Task contract, reducer validation, authoritative evidence store, immutability test | Complete |
| Repair tasks use ordinary workers | Two-worker scheduler assertion and full ordinary integration fixture | Complete |
| Planning is exactly once across restart | SQLite reopen, reordered semantic replay, one-event assertion | Complete |
| Repair integration invalidates obsolete verification | Real integrated transition advances revision and moves generation to history | Complete |
| Fresh generation waits for terminal repairs | Remaining-live guard plus typed fresh plan at repaired revision | Complete |
| Approved review creates no repair work | Focused approved-review runtime case | Complete |
| Later lifecycle work remains out of scope | No `complete_run`, cleanup, or UI changes | Complete |

## Packet status

P2.4B3 repair orchestration and fresh-generation lifecycle are complete. The
P2.5 completion gate and P2.6 cleanup/UI remain intentionally deferred.

## P2.5 authoritative completion gate

Added one exported scheduler-boundary completion predicate/assertion and routed
every Finish/Budgeted completion authority through it. The predicate requires
all ordinary implementation and verification-repair tasks to be integrated or
validly cancelled, a nonempty canonical integration revision, one current
kernel verification generation targeting that exact revision, an exact bound
kernel task, a valid four-category P2.1 plan, one green persisted completed fact
per category, required-category facts/evidence, justified N/A representation,
one exact green P2.3 submission/result, and one structured current Architect
approval whose category rationales and evidence references exactly match the
submission. Invalidated history is auditable but cannot satisfy the current
singleton requirement.

The reducer now invokes the assertion for raw/replayed `run.completed`,
`project.handoff_requested`, and `project.handoff_selected` events. Selection
also requires its result revision to equal the verified canonical revision.
The typed `complete_run` tool evaluates the same predicate and returns
`completion_not_ready` with structured issues before append; the reducer remains
the final authority. BuildRuntime advances an approved current generation to
the existing typed completion-decision action, and its generation-specific
postcondition prevents prose/no-op handoff creation.

Direct BuildRuntime selection still appends through the reducer. NativeBuildManager
now asserts readiness before invoking the physical project-handoff driver, so a
stale selection cannot mutate the user project before durable rejection. The
generic RunSupervisor gained `completeBuild`, which accepts completion only
when the authoritative SchedulerProjection is both durably completed and
readiness-green. Control and CLI synchronization use that method and therefore
cannot convert a forged `BuildStepResult { status: "completed" }` into generic
completion. Plan-only retains its intentional valid-plan/user-choice lifecycle;
no Finish/Budgeted compatibility or bypass flag was added. Legacy raw-completion
tests now assert the no-grandfathering invariant.

### P2.5 TDD and fault evidence

The focused completion test was created first. Its initial run failed 0/1:

```text
npx tsx --test runner-v2/test/final-verification-completion.test.ts
Missing expected exception: run.completed must reject missing ordinary task terminal
```

Subsequent red-first boundaries found and fixed:

- valid approved BuildRuntime returned `idle` instead of requesting handoff;
- control synchronization changed the generic run to `completed` from a forged
  completed result instead of leaving it `running`;
- NativeBuildManager called the physical handoff once before stale reducer
  rejection (`1 !== 0`);
- RunSupervisor had no gated Build completion method.

Three mandated fault-only mutations were made and restored:

- Removing the raw `run.completed` reducer assertion made the raw matrix fail
  0/1 with `Missing expected exception` for a nonterminal ordinary task.
- Removing the current-target/canonical-revision equality guard made the raw
  matrix fail 0/1 with `Missing expected exception` for the current revision.
- Allowing RunSupervisor to complete directly from the generic result made its
  focused test fail 0/1: actual `completed`, expected `running`.

The restored focused suite passed 7/7.

### P2.5 validation evidence

```text
npx tsx --test runner-v2/test/final-verification-completion.test.ts runner-v2/test/architect-tools.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/native-build-manager.test.ts runner-v2/test/control-server.test.ts runner-v2/test/recovery-smoke.test.ts runner-v2/test/recovery.test.ts
96/96 passed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

npx eslint runner-v2/src/architect-tools.ts runner-v2/src/build-runtime.ts runner-v2/src/cli.ts runner-v2/src/control-server.ts runner-v2/src/native-build-manager.ts runner-v2/src/run-supervisor.ts runner-v2/src/scheduler-store.ts runner-v2/test/final-verification-completion.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/native-build-manager.test.ts runner-v2/test/scheduler-store.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

### P2.5 requirement audit

| P2.5 requirement | Evidence | Result |
|---|---|---|
| Shared durable completion assertion | Exported scheduler predicate/assertion used by all terminal reducers | Complete |
| Ordinary tasks and canonical revision terminal/current | Raw matrix dimensions and predicate checks | Complete |
| Exact current green four-category submission | Completed-fact/submission identity, category, attempt, plan, evidence checks | Complete |
| Exact structured semantic approval | Review identity, current revision, category rationale/verdict/evidence checks | Complete |
| Obsolete history cannot authorize completion | Missing-current/history fixture and revision-advance case | Complete |
| Tool/prose bypasses fail closed | Structured tool error and runtime typed-action postcondition | Complete |
| Raw/SQLite forged events fail closed | Three-event raw matrix plus SQLite append/replay fixture | Complete |
| Direct/native/control/CLI paths are gated | Runtime reducer, pre-physical manager assertion, supervisor synchronization | Complete |
| Revision advancement immediately blocks all paths | Tool, raw completion, and direct selection stale test | Complete |
| Plan-only and user choice remain unchanged | Existing plan-only runtime/store/native-manager affected tests | Complete |
| P2.6 remains out of scope | No cleanup, audit export, client, observability, or UI behavior added | Complete |

## Packet status

P2.5 authoritative completion enforcement is complete. P2.6 cleanup, audit,
client projection, observability, and UI work remain intentionally deferred.

## P2.6A exact-owned cleanup primitives

Added explicit durable browser-session run ownership and exact
`PlaywrightBrowserBackend.closeRun(runId)` cleanup. Production opens supply the
owner; metadata binds owner and session identity; recovery validates it.
Final-verification session IDs now contain run, generation, task, and attempt.
Cleanup examines only individual state files, validates hashed metadata paths,
and never removes the browser-state root; foreign metadata is preserved.

Added `FinalVerificationDiagnosticsArchive`, which validates the dirty
worktree through its existing Git ownership proof and atomically writes a
bounded, redacted snapshot under the run's Runner-state audit root. Added
`OwnedFinalVerificationCleanup` with fixed order: authenticated process-tree
stop, exact-run browser close, required failed diagnostics persistence, then
ownership-validating workspace cleanup. Pre-cleanup failures are bounded and
aggregated and prevent workspace removal; successful cleanup is idempotent.

`NativeBuildFactory` constructs and exposes the primitive as
`NativeBuildRuntimeHandle.finalVerificationCleanup` for the next lifecycle
packet. Scheduler events, completion/handoff, UI/client projection, and repair
routing remain unchanged.

### P2.6A TDD and fault evidence

The browser tests were first: five existing cases passed and both new cases
failed with `TypeError: reopened.closeRun is not a function`. After the slice,
7/7 passed. The cleanup test was then added before its module and failed with
`ERR_MODULE_NOT_FOUND`. Its first behavioral run was 1 pass/3 fail because the
aggregate error hid underlying reasons; bounded details fixed that and 4/4
passed.

Fault-only mutations were restored after proving red:

- Removing `ownerRunId === runId` made the exact-run test fail 0/1 because run
  A cleanup deleted run B's persisted session.
- Deleting the worktree before diagnostics made the archive-order test fail
  0/1 with missing ownership metadata.

### P2.6A validation evidence

```text
Focused browser/cleanup/runtime/workspace/process/worker/Architect set:
53 tests, 53 passed, 0 failed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

Targeted ESLint
passed with no warnings

git diff --check
passed (normal LF-to-CRLF warnings only)
```

| P2.6A requirement | Evidence | Result |
|---|---|---|
| Exact persisted browser owner | Versioned metadata and cross-run reopen test | Complete |
| No task collision across runs/generations | Run-qualified and generation-qualified session IDs | Complete |
| Foreign metadata cannot delete across runs | Owner/path filters and tamper test | Complete |
| Failed dirty diagnostics precede deletion | Real dirty Git fixture, archive, ordering fault | Complete |
| Diagnostic/process failures retain workspace | Injected failures and existence assertions | Complete |
| Wrong/missing ownership refuses deletion | Tampered owner plus existing ownership-pair tests | Complete |
| Idempotent exact cleanup | Repeated cleanup fixture | Complete |
| Factory exposure only | Typed handle surface and factory construction | Complete |

P2.6A primitives are complete. Durable lifecycle wiring, handoff blocking,
client/UI projection, repair routing, and Playwright E2E remain deferred.

## P2.6B1 durable cleanup lifecycle

Replaced the P2.6A per-process `completed` shortcut with mandatory
generation/task/target identity and durable per-generation cleanup receipts.
Receipts live beneath the run-owned audit root, survive restart, conflict on a
foreign identity, and allow the crash window after physical removal but before
the scheduler success event to converge without a second deletion. A later
generation always owns a distinct receipt and cleans its newly created
workspace. `quiesceRun()` stops only authenticated run-owned process trees and
closes only exact-run browser sessions without touching diagnostics or the
verification workspace.

Added durable `cleanup_started`, `cleanup_succeeded`, and `cleanup_failed`
scheduler events and current/history projection state. The reducer enforces
runner authority, validated submission precondition, exact current identity,
sequential attempts, legal transitions, semantic idempotency, bounded failure
detail/archive reference, and conflicting/stale rejection. Invalidation clones
cleanup state into history but never lets it authorize a fresh generation.

BuildRuntime now starts cleanup after the validated green submission, invokes
the factory-owned cleanup driver, and durably records success or bounded,
secret-redacted failure. Started/failed states safely reconcile on resume and
restart. Architect review is unavailable until exact current cleanup succeeds.
The shared completion predicate also requires that success, so raw completion,
typed completion, handoff request, physical handoff selection, control, and
supervisor paths remain fail-closed.

NativeBuildManager quiesces exact-run resources on explicit pause, startup
recovery, autonomous no-progress pause, pump error, and paused public execution
results. Quiesce never invokes verification-workspace cleanup. Failures flow
through the existing pump error boundary and prevent automatic recovery
activation; no PID/port fallback was introduced.

### P2.6B1 red-first and fault evidence

- The first execution test went red when a green submission entered Architect
  review directly (`final_verification_review_required` no typed action) instead
  of recording cleanup.
- Pause/recovery tests went red with actual calls `[pause]` instead of
  `[pause, quiesce]`, and `[]` instead of `[quiesce]`.
- Cleanup failure/restart tests prove durable redacted failure, no review, and
  sequential attempt-2 success after SQLite reopen.
- Raw forged success without validated submission/start and stale cleanup after
  integration invalidation reject mechanically.
- Reopened receipt and durable-start replay cover cleanup crash windows; a
  later generation still removes its own workspace.

Fault-only mutations were restored after proving red:

- Removing cleanup from `buildCompletionReadiness` made the raw terminal matrix
  fail because `run.completed` accepted missing cleanup success.
- Reintroducing the old per-run completed boolean made the later-generation
  test fail because generation 2's workspace remained present.

### P2.6B1 current validation

```text
Affected final-verification/build/runtime/factory/manager/recovery/process/browser set:
109 tests, 109 passed, 0 failed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

Targeted ESLint
passed with no warnings

git diff --check
passed (normal LF-to-CRLF warnings only)
```

P2.6B1 durable cleanup lifecycle is complete. Non-green-to-repair cleanup
bridging, client/UI projection, broader audit export, and Playwright E2E remain
deferred to later P2.6 packets.

## P2.6B2 mechanical failure to durable repair work

Closed the non-green idle gap. The runner now derives and appends exactly one
deterministic `final_verification.failure_reported` event from the exact current
generation, task, revision, attempt, persisted failed categories, issue/fact
references, and evidence IDs. A mechanical failure cannot create a green
submission or review. Raw forged/stale reports and raw review approval fail in
the scheduler reducer.

BuildRuntime routes the failed generation through the P2.6B1 exact-owned
cleanup driver with the completed failed checks, evidence references, and
bounded issue diagnostics. Scheduler cleanup success for a mechanical failure
requires a durable diagnostics path; failed cleanup is redacted, blocks repair
planning, and retries sequentially after restart without duplicating the
failure report. Failure and diagnostics remain in invalidated history.

Verification repair provenance is now a discriminated source:
`semantic_review` binds the submission/review IDs, while `mechanical_failure`
binds the failure, issue, and fact IDs without inventing review artifacts. The
typed Architect repair tool and reducer independently require the exact current
source, cleaned failure, revision, category/evidence coverage, and valid
acceptance criteria. Every failed category is covered exactly once and the
created tasks are ordinary worker-schedulable `verification_repair` tasks.
Pre-discriminator semantic repair events replay into the new provenance shape.

Integrating the ordinary repair invalidates the failed generation. Fresh final
verification planning remains behind the existing all-ordinary-tasks-terminal
gate, creates one new generation at the new integration revision, and cannot
reuse old failure, diagnostic, or repair provenance as authority.

### P2.6B2 TDD and fault evidence

- The first restart-spanning end-to-end test failed 0/1 at the known branch:
  actual `final_verification_non_green`, expected
  `final_verification_failure_reported`.
- The fixture uses an actual child Node test command exiting 7, then drives:
  persisted non-green fact, deterministic failure report, restart, diagnostic
  cleanup, restart, typed Architect mechanical repair, and worker eligibility.
- A cleanup diagnostics guard was proven red 0/1: raw cleanup success without a
  diagnostics path raised `Missing expected exception`; the restored reducer
  rejects it.
- Runtime-boundary fixtures map timeout, cancellation, browser console/network
  policy failure, and missing required evidence into durable failure reports.
- Restart checkpoints before and after the failure report and cleanup retain
  exactly one failure event and retry only the sequential cleanup attempt.
- Raw forged/stale failure, raw review approval, and forged mechanical repair
  provenance reject atomically.

Mandated fault mutations were restored after proving red:

- Reintroducing the old idle-on-non-green return made the end-to-end test fail
  0/1: actual `final_verification_non_green`, expected
  `final_verification_failure_reported`.
- Removing exact mechanical failure identity validation made the raw provenance
  guard fail 0/1 with `Missing expected exception`.

### P2.6B2 validation evidence

```text
Focused execution and repair suites:
19 tests, 19 passed, 0 failed

Affected execution/cleanup/repair/review/completion/scheduler/Architect/
build-runtime/task scheduler/task graph/integration/factory/manager/recovery:
134 tests, 134 passed, 0 failed

Existing real FinalVerificationRuntime/browser failure mappings:
9 tests, 9 passed, 0 failed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

Targeted ESLint
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

P2.6B2 is complete. Client/UI projection, broader audit export, and Playwright
E2E remain deferred to later P2.6 packets.

## P2.6C canonical observability, audit, client, and UI

Added a stable final-verification observability projection derived directly
from the durable scheduler singleton. It represents the exact canonical and
target revisions, generation/task identity, all four category plans and
states, mechanical failure, submission, exact-owned cleanup, diagnostics
availability, Architect decision, repair task status, and eight bounded stale
history summaries. Evidence remains a mechanical fact and never becomes an
Architect approval.

The factory loads a diagnostics manifest only from the exact hashed run audit
directory beneath Runner state. The loader bounds bytes and list sizes,
validates schema plus run/generation/task/revision identity, re-redacts
sensitive assignments, rejects arbitrary or cross-run paths, and never exposes
the absolute diagnostics path. Both `/build/observability` and `/build/audit`
carry the same canonical projection.

Client contracts now type task kind, discriminated repair provenance, durable
final-verification state, and the canonical observability/audit shape. The
user-facing projection prefers canonical scheduler state over evidence
inference, always shows Build, Tests, Runtime, and Browser including pending
and N/A, and reports missing/stale verification, mechanical failure, cleanup
failure, and repair work as actionable blockers.

The Verification card is now a restrained flight-check manifest using existing
tokens: exact short revision/generation header, four responsive category lanes,
cleanup/diagnostics status, Architect release seal, and repair status. Static
render inspection confirmed a single-column narrow base that progressively
becomes two/four columns, semantic dark-mode token classes, no motion, and a
clear heading/list hierarchy. The task board labels the kernel task as Final
verification, derives its display state from checks/cleanup/review/repairs,
and keeps implementation-task counts separate.

### P2.6C TDD, mutations, and validation evidence

- Server RED: the focused test failed at import because
  `projectFinalVerificationObservability` and the strict diagnostics loader did
  not exist. Restored GREEN: 3/3.
- Client RED: evidence-only inference returned only a failed Tests row instead
  of the four canonical lanes. Restored GREEN: observability script PASS.
- Task-state RED: a planned kernel task remained `planned` while checks were in
  progress. Restored GREEN: build-live-state script PASS.
- UI RED: the flight-check manifest export did not exist. Restored GREEN:
  static task-board/UI render script PASS.
- Mutation 1, restored: forcing evidence-only inference failed the canonical
  matrix because Build, Runtime N/A, and Browser pending disappeared.
- Mutation 2, restored: dropping cleanup-failure status and blocker handling
  produced `cleanup_pending` instead of `failed` and failed the blocker test.

```text
final-verification observability + control server: 11/11 passed
client observability: PASS
task-board static render: PASS
build live state: PASS
Runner TypeScript: PASS
application TypeScript: PASS
targeted ESLint: PASS
git diff --check: PASS (normal LF-to-CRLF warnings only)
```

P2.6C is complete. Real-process/browser lifecycle E2E remains intentionally
deferred to the next P2.6 packet.

## P2.6D real-process, environment, and Playwright verification

Added `tests/e2e/runner-v2-final-verification.spec.ts` with deterministic local
Git fixtures under explicit temporary roots whose canonical project and Runner
state paths are siblings containing spaces. The five real-process cases prove:
exact-revision Build/Tests command arrays; runtime health through the Windows
managed-process service; a real Playwright browser context with DOM, screenshot,
console, and network evidence; generated-file isolation; diagnostics retention,
redaction, and arbitrary/cross-run refusal; explicit N/A and detected-script
rejection; integrated non-zero test detection; stale-revision refusal; durable
category resume/dedupe and singleton submission; CLI `--port 0` restart and port
release; and cancellation cleanup for descendant processes, browser contexts,
and assigned ports. No model or external network is used.

The E2E exposed one in-scope defect: after Build generated an untracked bundle
in the disposable verification worktree, the next scheduler-selected category
failed with `Verification workspace is dirty.` Added
`resumeForNextCheck()`, which relaxes only disposable-worktree cleanliness while
still validating exact ownership, target revision, canonical checkout state,
and Git association. `runCategory()` uses it only after the exact dirty-worktree
create error. The strict clean `create()`/`reopen()` APIs remain unchanged.

### P2.6D red and fault evidence

- Initial Playwright RED: production Runner modules were transformed as CommonJS
  and failed on `import.meta`; a scoped `tests/e2e/package.json` ESM boundary
  fixed loading without changing the repository package mode.
- Real resume RED: 2/3 then-current E2E cases passed; generated Build output made
  Tests fail at `Verification workspace is dirty.` The focused fix returned the
  resume case green while canonical-dirty and wrong-revision unit guards stayed
  red/green as intended.
- Removing the target-revision comparison made the stale E2E resolve instead of
  rejecting at its exact `rejects.toThrow` assertion.
- Forcing the scheduler to select the first check after restart produced
  `Evidence idempotency conflict for generation-resume:1:build:0`.
- Removing the screenshot-specific evidence guard made the browser suite 3/4;
  the missing-screenshot assertion saw only the generic missing-artifact issue.
- Running commands in the canonical repository instead of the owned workspace
  made the full E2E fail because `generated/bundle.txt` was absent from the
  verification worktree.
- Replacing owned-process stop with poll made cancellation cleanup fail with an
  `EBUSY` locked verification worktree.

Every fault was restored before final verification.

### P2.6D final validation

```text
npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5/5 passed in 21.3s (3.8s, 2.8s, 2.7s, 3.3s, 4.9s)

npx playwright test tests/e2e/responsive-tabs.spec.ts
2/2 passed in 4.8s

Affected Runner runtime/browser/execution/cleanup/workspace/build/recovery/
Node/Git set
49/49 passed in 22.08s

Node 22.13.0 node:sqlite smoke
passed; Git 2.53.0.windows.1 detected

Node 22.13.0 node-version + Git preflight
5/5 passed

npm run typecheck:runner-v2
passed

npx tsc --noEmit
passed

targeted ESLint
passed with no warnings

git diff --check
passed (normal LF-to-CRLF notices only)
```

Playwright's managed development server exited after each run. Generated public
Runner ZIP collateral was restored to the packet entry revision and is not part
of this commit. P2.6D is complete; final phase-wide packaging and review remain
with the controller.

## P2 review repair: durable verification integrity and stranded-state guards

Closed the durable-boundary findings from the P2 review. Scheduler append and
replay now validate every final-verification fact schema, its exact positional
EvidenceStore record, generation/task/attempt ownership, and every cited
content-addressed artifact. Artifact payload and metadata existence, address,
byte length, and SHA-256 are checked synchronously inside the SQLite scheduler
transaction and checked again during replay, so deletion or corruption cannot
survive restart, review, or completion. Production submission also requires an
ArtifactStore whenever facts cite artifacts, and NativeBuildFactory supplies
the same store to both BuildRuntime and SqliteSchedulerStore.

Cleanup success now fails closed without a scheduler-provided receipt authority.
The production authority loads only the deterministic Runner-owned receipt,
checks exact run/generation/task/revision identity, and, for failed generations,
requires the exact owned diagnostics path plus matching redacted diagnostics
identity. A self-consistent forged event chain therefore cannot reach review by
inventing cleanup success.

Two stranded-state paths are rejected at their durable source: an active
generation's verification-repair tasks cannot transition or reconcile to
cancelled, while cancellation remains permitted after that source generation
has been invalidated; and legacy unstructured `rejected` final-verification
reviews are rejected in favor of the typed, category-complete
`repair_required` contract. Restart preserves the requested review state after
a rejected forged transition.

The full Runner suite also exposed two affected compatibility details. Browser
snapshot titles are schema-checked as strings but may legitimately be empty,
matching the browser runtime contract. Cleanup-only integration startup now
uses the already validated durable presence of `run.completed`, rather than
reinterpreting a terminal legacy history against today's stronger completion
preconditions.

### Review-repair RED/GREEN and validation evidence

- RED 0/2: a structurally malformed fact with a matching evidence row and a
  plausible fact differing from its evidence row were both accepted. GREEN:
  both reject at append.
- RED: a forged green required check with no facts or evidence was accepted.
  GREEN: required green checks fail closed without exact evidence.
- RED: deleting a cited artifact after append did not affect scheduler replay.
  GREEN: deleted and byte-corrupt artifacts both reject on restart.
- RED: a complete green/submitted event chain could persist cleanup success
  without an owned receipt. GREEN: the pump records durable cleanup failure and
  no `cleanup_succeeded` event.
- RED 0/2: a current-generation repair task accepted cancellation, and an
  unstructured rejected review persisted a terminal state. GREEN: both
  transitions reject; reopen retains the prior actionable state.
- Exact full-suite failures after the first broad run were restored green:
  cleanup-only legacy initialization and an empty browser title.

```text
Focused integrity: 5/5 passed
Submission: 6/6 passed
Scheduler/execution/repair/review/completion: 40/40 passed
All final-verification tests: 87/87 passed
Artifact + NativeBuildFactory/Architect affected set: 11/11 passed

npm run test:runner-v2
first broad run: 489/491 passed; exact two failures repaired
exact failed checks plus integrity: 6/6 passed
all other 489 previously-green results proven unaffected by the two scoped fixes

npx tsc -p runner-v2/tsconfig.json --noEmit
passed

targeted ESLint
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF notices only)
```

This section records review repairs only and does not claim phase completion.

## P2 first-review repair commits (explicit evidence)

### `8bfe0639` — cleanup recovery, redaction, and bounded retry

This commit made failed verification cleanup recoverable and fail closed. It
added structural redaction for nested secret keys, command argument pairs,
authorization/bearer values, URL credentials/query values, and whitespace-form
environment assignments; bounded diagnostics and observability loading; made a
single autonomous cleanup failure return durable no-progress instead of hot
looping; recovered the crash after diagnostics persistence and workspace
deletion; and validated exact owned receipt path/identity/containment.

RED evidence was the existing focused cleanup/execution set: the nested/argv/
header/URL/env cases retained secrets, the autonomous cleanup failure repeated
within one `runUntilBlocked` invocation instead of returning
`final_verification_cleanup_failed`, and a forged receipt diagnostics path was
accepted. Removing the restored receipt authority again made the forged-receipt
case fail 0/1; restoring it returned the case green. Current exact revalidation:

```text
npx tsx --test runner-v2/test/final-verification-cleanup.test.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-observability.test.ts
21 tests, 21 passed, 0 failed
```

### `2a727bd5` — product-path execution-profile binding

This commit bound exact build/test argv, runtime-smoke input, browser input, and
runner-inspected category signals to the final-verification generation and
threaded them through NativeBuildFactory, BuildRuntime, and
FinalVerificationRuntime. Inspection uses clean canonical integration state,
not Architect prose or the dirty user checkout. The production factory E2E
proved all four categories while preserving a dirty user checkout.

RED evidence: the new product E2E could not obtain all four exact runtime inputs
through NativeBuildFactory; a real build/test/UI repository could be accepted
as all-N/A from prose-supplied inspection; and a dirty user checkout blocked
verification when used as inspection authority. Temporarily removing exact
profile propagation restored the factory-path failure; restoring it returned
the named factory test green. Current exact revalidation (the profile suite now
also contains the later durable-authority and provisioning guards):

```text
npx tsx --test runner-v2/test/final-verification-profile.test.ts runner-v2/test/native-final-verification-factory.test.ts runner-v2/test/native-architect-runtime.test.ts
21 tests, 21 passed, 0 failed
```

### `32216831` — event/evidence/artifact/receipt integrity

This commit made scheduler append and replay validate fact schema, exact
EvidenceStore correspondence, artifact existence/hash/length, production
submission authority, and authentic cleanup receipts. It also closed the
cancelled-repair and unstructured-review stranded states. The original RED and
restored mutations are recorded in the preceding combined review section:
malformed/mismatched facts 0/2, green-without-evidence accepted, deleted artifact
accepted on replay, forged cleanup success accepted, and the two stranded-state
transitions accepted. Every injected fault was restored. Current exact
revalidation:

```text
npx tsx --test runner-v2/test/final-verification-integrity.test.ts runner-v2/test/final-verification-submission.test.ts runner-v2/test/final-verification-repair.test.ts runner-v2/test/final-verification-review.test.ts runner-v2/test/final-verification-completion.test.ts runner-v2/test/final-verification-scheduler.test.ts
47 tests, 47 passed, 0 failed
```

## P2 second-review repair commits

### `3e9db443` — durable runner-owned profile authority

Execution profiles became mandatory for every non-plan-only generation,
projection, runtime, submission, and completion path. A content-addressed
Runner-owned archive binds run ID, exact integration revision, and complete
profile content and survives restart/worktree retirement. Production SQLite
append and replay fail closed without that authority and reject missing,
tampered, replay-tampered, or stale profiles while accepting only the
idempotent duplicate of the same inspected profile. Runner-owned detected
signals reject false all-N/A plans.

RED tests first showed raw missing and self-consistent uninspected profiles
could create generations, profile bytes could be changed before replay, and a
real signalled repository could be marked all-N/A. Disabling production
`validateExecutionProfile` after the fix made the fail-closed test red; restoring
the callback requirement returned it green. These cases are included in the
current 21/21 profile/factory/Architect command above.

### `0e842199` — one shared mechanical semantic validator

One validator now binds every completed check and submission to the exact
persisted profile, expected cardinality, executable/argv/label/requested URL,
and full green semantics. Build/tests require exit zero with no signal, timeout,
cancellation, truncation, or issues. Runtime requires readiness, endpoint,
nonzero handling, and explicit successful owned-process cleanup. Browser binds
requested URL while allowing normal redirects and requires snapshot,
screenshot, events, and absence of timeout/cancellation/policy issues.

RED chains with an alternate command and nonzero-but-green facts were accepted
before the validator. A green runtime with absent/false cleanup success and a
green fact carrying non-empty issues were also accepted. Removing the explicit
runtime cleanup-success requirement made its named append/replay tests red;
restoring it returned the final-verification affected set to 95/95 at the
packet boundary. Current integrity/semantic revalidation is 47/47 above, and
the current production-path set below is 38/38.

### `ef0d339c` — exact dependency provisioning and owned ports

Exact-revision inspection now detects `packageManager` plus lockfiles,
conservatively supports npm/pnpm/yarn, fails closed on declaration/lock
disagreement or unavailable managers, and persists shell-free install argv.
Dependencies are provisioned inside the disposable workspace before project
scripts, including lockfile/workspace cases with empty root dependency maps.
Dynamic port reservations are generation/revision/lease-ID scoped, durable
across restart, rotated after integration advancement, released by exact
cleanup, and discarded when profile persistence, Architect planning, or
scheduler append fails.

Prove-red mutations and restoration:

- removing provisioning made the real local-dependency NativeBuildFactory E2E
  fail before build; restoration made it green;
- accepting a mismatched package-manager lock made the exact conflict test red;
- replacing reservations with a fixed port made the two-profile isolation test
  red;
- omitting returned-tool-error lease discard orphaned a port after mechanically
  rejected generation append;
- Windows dependency-tree cleanup initially failed with `Directory not empty`;
  the scoped post-worktree-removal fallback restored the real E2E.

Packet-boundary affected validation was 127/127. Current exact validation:

```text
npx tsx --test runner-v2/test/native-final-verification-factory.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-profile.test.ts runner-v2/test/final-verification-semantics.test.ts runner-v2/test/final-verification-cleanup.test.ts
38 tests, 38 passed, 0 failed
```

### `72353566` — changed-path redaction and legacy archive repair

New diagnostics writes redact and bound `changedPaths` before persistence.
Receipt-first restart recovery now repairs only an exact-identity Runner-owned
legacy archive atomically, without needing the deleted workspace; synchronous
scheduler append/replay validation remains fail closed until repair completes.
The regression reproduces: unsafe archive persisted, workspace deleted, receipt
written, scheduler validation rejected, process restarted, archive sanitized,
validation accepted, and cleanup repeated idempotently.

```text
Initial RED named regression: 0/1, unsafe or unbounded archive
Fault mutation removing receipt repair hook: 0/1, same exact rejection
Restored named regression: 1/1 passed
Focused cleanup: 10/10 passed
Affected cleanup/execution/recovery: 19/19 passed
```

The repaired durable JSON contains `[REDACTED]`, contains no injected
`legacy-changed-path-secret`, and bounds `changedPaths` to 200 entries.

### `0212ab07` and `6ca7409d` — current E2E/profile fixtures and bundles

The affected Playwright gate initially passed 1/5; four legacy fixtures failed
with `Final verification execution profile is required.` The restart case now
uses `FinalVerificationProfileAuthority` for initial append and SQLite reopen
and supplies the authoritative ArtifactStore. Direct runtime-mechanics cases
carry exact matching profiles without weakening the production store boundary.
The first migration pass passed 4/5; fixing the runtime/browser-only helper
made the exact cancellation case 1/1 and the complete gate 5/5. The production
build regenerated both tracked Runner ZIPs from current source.

## Current phase-wide review-repair validation

```text
npm run test:runner-v2
511 tests, 511 passed, 0 failed
all chained client, policy, UI, pause, model-usage, live-state, transcript,
files, stats, and observability scripts passed

npm run typecheck:runner-v2
passed

npm run lint
passed

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

git diff --check
passed
```

The 511/511 full Runner run occurred after every production-source repair,
including `72353566`. The only later source-controlled changes were the E2E
fixture migration and deterministic published ZIP regeneration; their exact
Playwright, lint, publication, and production-build gates are current. Node
policy remains maintained LTS lines 22/24 with the capability floor and no
exact `24.18.0` pin. This appendix records repair evidence and does not claim
phase completion.

## P2 independent re-review corrections

### Correction: browser policy semantics were not fully authoritative

The earlier `0e842199` section claimed full browser mechanical semantics. That
claim was disproven: durable semantics trusted the captured
`policyViolations` summary and accepted a required green browser fact carrying
an unallowlisted console error under `consoleErrors: "fail"`. Runtime had the
real evaluator, but append, reducer, replay, and submission did not recompute
the exact persisted policy.

Commit `6b180f8d` corrects the authority boundary. One pure browser policy
evaluator is now shared by runtime capture and durable semantics. It validates
console/page/network event item shapes, classifies exact failures, applies
console/page/network policy and allowlists, produces the canonical violation
list, and enforces event-count equality/lower bounds. Durable semantics requires
the supplied violation list to equal that recomputation; a green check requires
zero recomputed violations. Requested URL remains profile-bound while a normal
observed redirect remains valid.

RED and restore evidence:

```text
direct semantics before fix: 1/3 passed, 2/3 failed
submission forged empty violation summary: 0/1 passed
raw SQLite append forged empty violation summary: 0/1 passed
SQLite replay with scheduler+evidence tamper: 0/1 passed
fault mutation replacing persisted fail policy with all-allow: 0/1 passed
restored named mutation test: 1/1 passed

npx tsx --test runner-v2/test/final-verification-browser-policy.test.ts runner-v2/test/final-verification-browser.test.ts runner-v2/test/final-verification-integrity.test.ts runner-v2/test/final-verification-submission.test.ts
26 tests, 26 passed, 0 failed

npm run typecheck:runner-v2
passed

targeted ESLint and git diff --check
passed
```

### Correction: redaction key coverage was not comprehensive

The earlier `8bfe0639` and `72353566` sections correctly described the then-
tested exact keys but overstated structural coverage. The previous regex leaked
common nested/object/argv/env/text/query/changed-path forms including
`access_token` and `client_secret`, and could produce malformed partial text
redaction.

Commit `d34ee668` centralizes `isSensitiveKey` and applies it to object keys,
argv pairs, text assignments, URL query names, and therefore changed paths and
legacy archive repair. It recognizes snake, kebab, camel, argv, env, and query
forms for access/refresh/ID/API tokens, client secrets, API/private keys,
password/passwd/passphrase, authorization/auth, and credentials. Bearer values
and URL credentials remain protected. `secretary` and `tokenizer` remain
visible, redaction is idempotent, and assignment-shaped array values cannot be
mistaken for argv keys.

The legacy regression now exercises the exact sequence with both
`access_token` and `client_secret`: unsafe archive persisted, workspace deleted,
receipt written, scheduler validation rejected, restart repairs the owned
archive without the workspace, synchronous validation succeeds, and repeated
cleanup is idempotent.

RED and restore evidence:

```text
direct structural redaction before fix: 0/2 passed
diagnostics nested/argv/env/query coverage before fix: 0/1 passed
legacy receipt-first archive repair before fix: 0/1 passed
fault mutation disabling multipart key classification: 0/1 passed
restored direct redaction: 2/2 passed
restored legacy restart repair: 1/1 passed

npx tsx --test runner-v2/test/sensitive-redaction.test.ts runner-v2/test/final-verification-cleanup.test.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-observability.test.ts
23 tests, 23 passed, 0 failed

npm run typecheck:runner-v2
passed

targeted ESLint and git diff --check
passed
```

These corrections supersede the two overbroad claims while preserving the
historical packet evidence. They record fixes and do not claim phase completion.

## Fresh post-re-review broad-gate evidence

The following gates were run after commits `6b180f8d`, `d34ee668`, and
`2ab16809`. The first unbounded full-suite invocation completed its test child
but left an orphaned Windows npm/cmd wrapper without an observable exit result;
that wrapper alone was terminated, and the identical command was immediately
rerun with bounded output capture. Only the rerun below is counted as gate
evidence.

```text
affected combined final-verification tests
112 tests, 112 passed, 0 failed

npm run test:runner-v2
519 tests, 519 passed, 0 failed
all 11 chained product client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed
exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source
```

Commit `0ba25595` records the deterministic Runner V2 and WorkBench bundles
generated from the reviewed source. Node policy remains the maintained 22/24
LTS ranges with the required `node:sqlite` capability floor and no exact Node
24 patch pin. This section is current implementation evidence and does not
declare the P2 phase outcome.

## P2 follow-up re-review corrections

### Correction: browser policy was not fail-closed before profile cloning

The `6b180f8d` correction made runtime and durable semantics share one policy
evaluator, and `3e9db443` made the execution-profile archive authoritative, but
the profile envelope still only checked that `browser.policy` was an object.
For example, `allowedConsoleErrorPatterns: "e"` passed profile validation;
`cloneBrowser` spread that string into `["e"]`, and the normalized value could
match a legitimately archived profile. The earlier statements that the exact
persisted policy was validated at every durable boundary were therefore too
broad.

Commit `09ffd77b` exports one pure exact policy-schema assertion from the
shared browser-policy module and invokes it from execution-profile validation
before clone, digest, archive lookup, scheduler append, or replay. It permits
only the three `fail`/`allow` modes and the three known allowlist keys. Each
allowlist must be an array of no more than 32 nonempty strings, each at most
256 characters; unsupported fields and malformed values reject. Exact arrays,
allowlisted failures, and normal redirects remain valid.

The append and replay proof was subsequently split into independently failing
tests in commit `c2bb5f8b`, so an append failure cannot mask the replay branch.

RED, mutation, and restore evidence:

```text
initial focused run: 16/19 passed, 3 failed
- direct malformed/unknown policy semantics failed
- direct profile/clone reproduction failed
- runner-owned authority accepted malformed append after clone normalization

fault mutation disabling the profile schema call:
direct clone + append cases: 0/2 passed
independent replay-only case: 0/1 passed

restored direct clone/append/replay cases: 3/3 passed
affected profile/policy/semantics/integrity/submission: 37/37 passed
```

### Correction: structural redaction did not cover JSON encoded as text

The `d34ee668` correction covered structural object keys and ordinary
assignments, but its claim of comprehensive diagnostic text coverage was too
broad. Complete JSON strings such as
`{"access_token":"JSON_ACCESS_SECRET","clientSecret":"JSON_CLIENT_SECRET"}`
and quoted JSON properties embedded in ordinary logs bypassed assignment
matching and leaked into new archives, observability responses, and repaired
legacy archives.

Commit `82e24f58` adds bounded structured JSON text handling before URL,
assignment, and bearer redaction. Complete JSON object/array containers are
parsed, passed through the existing key/argv/value redactor, and serialized as
valid JSON. A separate exact quoted-property pass handles safely determinable
JSON fragments embedded in ordinary diagnostics, including escaped string and
non-string values. JSON recursion is capped at eight encoded levels, object
depth/item/text limits are preserved, and container discovery attempts are
bounded. Invalid ordinary text, `secretary`, and `tokenizer` remain visible;
URL credentials/query keys, bearer values, maximum text length, and idempotence
remain covered.

The archive regressions exercise both newly written diagnostics/logs and the
exact legacy sequence: unsafe archive persisted, workspace deleted, owned
receipt present, synchronous receipt validation rejected, restart repaired the
archive without the workspace, receipt validation succeeded, and repeated
cleanup remained idempotent.

RED, mutation, and restore evidence:

```text
initial affected run: 12/17 passed, 5 failed
- complete/nested/array JSON text leaked
- embedded quoted JSON properties leaked
- new diagnostics archive logs leaked
- observability loader leaked
- receipt-first legacy archive repair leaked

fault mutation disabling structured JSON containers: 1/2 passed
  (JSON argv array secret leaked)
fault mutation disabling embedded quoted properties: 0/1 passed

restored direct/cleanup/observability tests: 17/17 passed
restored affected set including durable execution: 25/25 passed
```

### Current post-correction validation

```text
Node.js 22.13.0 scoped new/expanded regressions
8 tests, 8 passed, 0 failed

combined final-verification plus structural-redaction gate
120 tests, 120 passed, 0 failed

npm run test:runner-v2
525 tests, 525 passed, 0 failed
all 11 chained client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed; exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source
```

An exploratory attempt to run the entire profile file through the ephemeral
`npx node@22.13.0` runtime passed 18/19; its pnpm provisioning fixture could not
run because that ephemeral Node package does not include an available Corepack
pnpm CLI. This was an environment-availability result, not a product assertion
failure. The eight new/expanded Node 22 regressions were then selected directly
and passed 8/8. Commit `98d7340c` records the deterministic reviewed bundles.
Node policy remains maintained LTS lines 22/24 with the capability floor and no
exact Node patch pin. This section corrects prior claims and records evidence;
it does not declare the P2 phase outcome.

## P2 structured-text redaction re-review correction

### Correction: embedded container-valued properties and late keys could bypass redaction

The `82e24f58` section correctly reports protection for complete JSON text and
scalar-valued quoted properties, but its structured-text coverage claim was
still too broad. The quoted-property matcher accepted only string, boolean,
null, and numeric values. Therefore an otherwise recognizable sensitive key
whose value was an embedded object or array remained visible. Separately, the
generic JSON-container discovery pass stopped after 64 candidate opening
braces, so unrelated malformed prefix text could exhaust discovery before a
later sensitive property.

Commit `1c878c0b` replaces scalar-only property matching with a key-directed,
escape-aware JSON-value scanner. It scans quoted keys across the full
diagnostic string, classifies them through the shared `isSensitiveKey`, and
replaces the complete following string, scalar, object, or array value. A
balanced container is consumed as one value, preserving valid surrounding JSON
and ordinary diagnostic text; an unclosed or otherwise indeterminate value is
handled fail-closed. Because discovery starts from the recognized sensitive
key, unrelated malformed braces cannot consume a global security-attempt
budget. Existing structural recursion/item/text limits, maximum output length,
URL/bearer/assignment handling, false-positive controls, and idempotence remain
in force. The 64-attempt limit remains only an optimization for generic
parseable-container normalization and is no longer authoritative for finding
sensitive properties.

The regressions cover an embedded sensitive object with nested and escaped
content, an embedded sensitive array containing nested containers, and a later
sensitive object after 65 malformed opening braces. The same cases flow through
new diagnostics persistence, the bounded observability loader, and the exact
legacy receipt-first recovery sequence after workspace deletion.

RED, mutation, restore, and current gate evidence:

```text
pre-fix focused redaction/cleanup/observability gate
20 tests, 14 passed, 6 failed
- embedded sensitive object value leaked
- embedded sensitive array value leaked
- later sensitive value after 65 malformed braces leaked
- new diagnostics archive, observability loader, and legacy receipt-first
  restart repair leaked the corresponding values

fault mutation bypassing the key-directed quoted-property pass
3 tests, 0 passed, 3 failed

restored direct guards
3 tests, 3 passed, 0 failed

restored focused redaction/cleanup/observability gate
20 tests, 20 passed, 0 failed

Node.js 22.13.0 scoped direct, diagnostics, observability, and recovery guards
6 tests, 6 passed, 0 failed

combined final-verification plus redaction gate
123 tests, 123 passed, 0 failed

npm run test:runner-v2
528 tests, 528 passed, 0 failed
all 11 chained client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed; exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source

targeted ESLint, full lint, git diff --check, and fix-only diff inspection
passed
```

Commit `273e84bb` records the deterministic Runner V2 and WorkBench bundles
generated from `1c878c0b`. Node policy remains maintained LTS lines 22/24 with
the capability floor and no exact Node patch pin. This correction records
current implementation evidence and does not declare the P2 phase outcome.

## P2 recursively encoded structured-text re-review correction

### Correction: quote ambiguity and JSON string encoding could still hide secrets

The `1c878c0b` section correctly reports container-valued property redaction,
but its claim that key-directed scanning covered the full diagnostic string was
too broad. The prior scanner consumed an entire parsed non-key string and then
continued after its closing quote. In malformed ordinary text, that same quote
can also be the opening quote of the next sensitive key, so the candidate was
never reconsidered. Separately, a valid JSON string literal containing encoded
JSON was opaque: its decoded object, array, and nested string values never
reached structural redaction.

Commit `8fbb1178` replaces quote skipping with two linear quote-boundary
automata. Each unescaped quote can close the current candidate and immediately
become the opener for the next candidate, so unrelated or unmatched quote text
cannot hide a later raw key or encoded literal. The property automaton remains
key-directed and consumes a complete exact JSON value only after the decoded
key is classified by `isSensitiveKey`.

The second automaton decodes valid JSON string literals, recursively applies
the same structural/text redactor, and re-encodes only changed values. Recursion
remains capped at eight encoded text levels. At that cap, a separate structural
inspection is capped at 64 decode steps: it preserves documented safe
`secretary` and `tokenizer` content, redacts determinable nested credentials,
and fails closed only if the inspection bound itself is exhausted. Object
depth, item count, maximum text length, complete JSON validity, surrounding
ordinary text, URL/bearer/assignment behavior, and idempotence remain covered.
The quote scans are single pass, and recursive/bound inspection has explicit
caps rather than a global attempt budget that a prefix can consume.

The direct regressions cover the exact unmatched-quote reproduction; one
encoded object string with scalar, object, array, nested, and multiple sensitive
keys; recursive string encoding; fail-closed depth behavior; safe deep encoded
false-positive controls; and the combined unmatched-prefix plus encoded-literal
case. New diagnostics persistence, bounded observability loading, and the exact
legacy receipt-first restart repair all exercise raw and encoded variants.

RED, mutation, restore, and current gate evidence:

```text
pre-fix focused direct/cleanup/observability gate
23 tests, 17 passed, 6 failed
- unmatched quote hid a later sensitive object value
- encoded multi-key object and nested encoded string leaked
- diagnostics persistence, observability, and receipt-first repair leaked

pre-fix selected direct guards
4 tests, 0 passed, 4 failed

combined unmatched-prefix plus encoded-literal guard against first correction
1 test, 0 passed, 1 failed

self-review safe deep-encoding guard against unconditional cap fallback
1 test, 0 passed, 1 failed

fault mutation bypassing recursive JSON string-literal redaction
4 tests, 0 passed, 4 failed

fault mutation disabling shared-quote reconsideration in the key pass
1 test, 0 passed, 1 failed

restored focused direct/cleanup/observability gate
26 tests, 26 passed, 0 failed

Node.js 22.13.0 scoped direct, persistence, observability, and recovery guards
9 tests, 9 passed, 0 failed

combined final-verification plus redaction gate
129 tests, 129 passed, 0 failed

npm run test:runner-v2
534 tests, 534 passed, 0 failed
all 11 chained client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed; exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source

targeted ESLint, full lint, git diff --check, and fix-only diff inspection
passed
```

Commit `f07c2593` records the deterministic Runner V2 and WorkBench bundles
generated from `8fbb1178`. Node policy remains maintained LTS lines 22/24 with
the capability floor and no exact Node patch pin. This correction records
current implementation evidence and does not declare the P2 phase outcome.

## P2 raw escaped-fragment redaction re-review correction

### Correction: raw JSON-string-content escape layers could remain opaque

The `8fbb1178` section correctly reports recursively redacting complete JSON
string literals, but its encoded-text coverage claim did not extend to raw
diagnostic fragments such as `payload={\"access_token\":\"value\"}`. Those
backslash-quoted tokens are JSON string *content* rather than a complete JSON
string literal. Odd-backslash quotes were deliberately skipped by both quote
automata, while the generic container parser could not parse the raw escaped
fragment, leaving the credential value visible. The same gap reached durable
diagnostics, receipt-first recovery repair, and observability loading because
all three correctly share this redactor.

Commit `7f276396` adds one bounded raw JSON-string-content layer decoder. It is
activated only when an escaped token is classified by the shared
`isSensitiveKey`, so unrelated escaped diagnostic strings and documented
`secretary`/`tokenizer` false positives retain their existing representation.
The decoder splits only at truly unescaped quote boundaries, decodes maximal
JSON-string-content segments with backslash-parity awareness, recursively
applies the existing structural redactor, and re-encodes only changed content.
This preserves complete JSON validity, existing valid encoded-string behavior,
single-quote wrappers, determinable surrounding diagnostic text, and
idempotence. Malformed authorized content that cannot be decoded is replaced
fail-closed. The existing eight-level text recursion cap and 64-step bounded
deep inspection remain in force; malformed brace prefixes do not consume a
global security discovery budget because activation is sensitive-key-directed.

The direct regressions cover one-layer raw escapes, single-quote wrapping,
object/array/nested/argv/multiple-key forms, even and odd backslash layers,
unmatched quote prefixes, a sensitive fragment after 65 malformed braces, and
indeterminate malformed authorized content. Diagnostics persistence, exact
legacy unsafe archive -> deleted workspace -> cleanup receipt -> restart
repair, and the bounded observability loader cover the same raw fragment
family durably.

RED, self-review repair, mutation, restore, and current gate evidence:

```text
pre-fix focused redaction/cleanup/observability gate
33 tests, 23 passed, 10 failed
- all seven new direct raw escaped-fragment guards failed
- diagnostics persistence, receipt-first restart repair, and observability
  loader retained their raw escaped secret values

first implementation self-review gate
33 tests, 31 passed, 2 failed
- activation on every backslash-quoted token re-encoded an unrelated safely
  parseable diagnostic and failed to preserve one existing surrounding-text
  contract
- activation was narrowed to escaped tokens classified by isSensitiveKey

fault mutation bypassing the raw escape-layer redaction pass
7 tests, 0 passed, 7 failed

restored direct raw escaped-fragment guards
7 tests, 7 passed, 0 failed

restored focused redaction/cleanup/observability gate
33 tests, 33 passed, 0 failed

Node.js 22.13.0 scoped direct, diagnostics, observability, and recovery guards
10 tests, 10 passed, 0 failed

combined final-verification plus redaction gate
136 tests, 136 passed, 0 failed

npm run test:runner-v2
541 tests, 541 passed, 0 failed
all 11 chained client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed; exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source

targeted ESLint, full lint, git diff --check, and fix-only diff inspection
passed
```

Commit `afc003c0` records the deterministic Runner V2 and WorkBench bundles
generated from `7f276396`. Node policy remains maintained LTS lines 22/24 with
the capability floor and no exact Node patch pin. This correction records
current implementation evidence and does not declare the P2 phase outcome.

## P2 raw-key authority and source-span re-review correction

### Correction: Unicode-escaped keys and whole-text re-encoding broke the contract

The `7f276396` section correctly reports one-layer raw fragment coverage, but
two claims were too broad. Its activation regex classified only literal ASCII
key text, so valid JSON Unicode escapes in any part of `access_token` or
`clientSecret` bypassed authority. It also decoded and re-encoded the complete
diagnostic after activation. That changed determinable unrelated context—for
example, adding an escape before an unmatched quote—and a key-like prose token
near an unrelated invalid escape could make the entire diagnostic fail closed
without ever proving a property relationship.

Commit `88fc2458` replaces global activation/transformation with bounded,
property-aware source-span handling. It decodes an exact raw escaped key token,
including JSON Unicode escapes, then classifies the decoded key through the
shared `isSensitiveKey`. Authority requires an exact property colon or a
recognized argv-pair relationship; an isolated `\"access_token\"` mention is
not authority. The value suffix is decoded through the key's exact escape
depth while retaining a source-boundary map. Only the exact sensitive value
span is replaced, preserving key spelling, Unicode escape spelling, quote and
backslash parity, unmatched-prefix text, and all other determinable context
byte for byte. String value wrappers are preserved exactly; object, array, and
scalar values are replaced as one bounded value. An invalid escape before a
mechanically proven value boundary remains fail-closed.

Key and quote inspection use the existing 64-step bounded policy. A new
12-layer raw-escape regression proves the earlier eight-layer/4,096-byte first
implementation cannot silently return. Complete JSON values still take the
existing structural/string path, avoiding redundant raw scanning while
preserving complete JSON validity, recursive encoded-string behavior, false
positive controls, output limits, and idempotence.

The direct regressions cover Unicode escapes at the prefix, middle,
underscore, and camel-case positions; property-aware benign malformed prose;
exact unmatched-quote and even-parity preservation; multi-key object, array,
and argv values; invalid-boundary fail-closed behavior; idempotence; and twelve
raw escape layers. Diagnostics persistence asserts the exact preserved log,
and legacy receipt-first restart repair plus observability loading cover
Unicode-escaped keys with opaque values.

RED, self-review, mutation, restore, and current gate evidence:

```text
pre-fix focused redaction/cleanup/observability gate
37 tests, 30 passed, 7 failed
- Unicode-escaped raw key values leaked in direct, persistence,
  receipt-first restart repair, and observability cases
- benign malformed prose was erased
- unmatched-quote and even-parity context was not preserved exactly

first source-mapped implementation boundary guard
1 test, 0 passed, 1 failed
- an invalid escape after a raw scalar made an unbounded malformed value look
  complete; invalid-boundary provenance was retained and made fail-closed

first source-mapped implementation 12-layer guard
1 test, 0 passed, 1 failed
- the initial eight-layer/4,096-byte key cap leaked the opaque value
- restored implementation uses the established 64-step inspection bound

fault mutation bypassing the source-mapped raw redaction pass
5 selected tests, 1 passed, 4 failed
- the benign prose test correctly remained unchanged without authority
- Unicode, exact context, even-parity, and malformed-boundary guards failed

restored selected authority and preservation guards
5 tests, 5 passed, 0 failed

restored focused redaction/cleanup/observability gate
39 tests, 39 passed, 0 failed

Node.js 22.13.0 scoped direct, persistence, observability, and recovery guards
9 tests, 9 passed, 0 failed

combined final-verification plus redaction gate
142 tests, 142 passed, 0 failed

npm run test:runner-v2
547 tests, 547 passed, 0 failed
all 11 chained client/policy/UI/pause/model-usage/live-state/transcript/
files/stats/observability scripts passed; exit 0

npm run typecheck:runner-v2
passed, exit 0

npm run lint
passed, exit 0

npx playwright test tests/e2e/runner-v2-final-verification.spec.ts
5 tests, 5 passed, 0 failed

npm run build
publish-downloads passed; Next production build passed; 20/20 static pages

npx tsx scripts/test-deploy-runner-artifacts.mts
1,127 PASS assertions, 0 FAIL assertions, exit 0
Runner V2 and WorkBench ZIP publication reproducible; public and exported ZIPs
byte-identical; every archived Runner source matched normalized current source

targeted ESLint, full lint, git diff --check, and fix-only diff inspection
passed
```

Commit `117fb39f` records the deterministic Runner V2 and WorkBench bundles
generated from `88fc2458`. Node policy remains maintained LTS lines 22/24 with
the capability floor and no exact Node patch pin. This correction records
current implementation evidence and does not declare the P2 phase outcome.
