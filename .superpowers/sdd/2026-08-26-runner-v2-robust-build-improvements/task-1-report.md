# Task 1 / Phase P1 execution report

## Execution metadata

- Worktree: `C:\Users\b_a_s\source\repos\ai-discussion-board\.worktrees\runner-v2-robust-build`
- Branch: `codex/runner-v2-robust-build`
- Review BASE: `0c01130ebc85d1d1f17399d49e6957989c95111e`
- Final HEAD: `f803fd7d`
- Date: 2026-08-26
- Scope completed: P1.0 through P1.6 only. P2 was not started.
- `progress.md` was read and not edited.

The implementation preserves the kernel rule: evidence records are mechanical facts and the Architect remains semantic authority. No product Build path imports the legacy benchmark engine.

## Requirements delivered

| Requirement | Evidence | Result |
|---|---|---|
| ENV-1 | Maintained Node 22.x and 24.x policy, actual unflagged `node:sqlite` floor `22.13.0`, package/scripts/docs/client/published artifacts, rejection of EOL/Current/malformed lines | Complete |
| HVI-2.1 | Stable `AcceptanceCriterion` IDs/text, versioned task contracts, plan/revision validation, legacy upgrade tool | Complete |
| HVI-2.2 | Exact worker criterion-to-evidence links with run/task/actor/attempt/artifact ownership checks | Complete |
| HVI-2.3 | Exact Architect criterion verdicts with rationale and evidence citations | Complete |
| HVI-2.4 | Retry/revision/replay/restart/client/audit projections and legacy compatibility coverage | Complete |

## Ordered packet record

### P1.0 — maintained-LTS Node compatibility

Commit: `b17efb5e runner-v2: support maintained Node LTS lines`

Implemented a strict compatibility contract for the maintained 22.x and 24.x lines. Node 22 requires the actual unflagged `node:sqlite` floor `22.13.0`; Node 24 accepts the maintained 24.x line. Current, EOL, below-floor, malformed, and unsupported majors are rejected. The package engine range is `>=22.13.0 <23 || >=24.0.0 <25`. Fixed-patch npm invocations, fixed-patch messaging, and fixed-patch packaging references were removed. CI/download/client/documentation surfaces were updated.

Pre-change proof: `npx tsx --test runner-v2/test/node-version.test.ts` against the fixed-patch baseline failed the new maintained-line acceptance cases because the old exact-version policy rejected supported Node lines. The package-script/client-policy/artifact checks also retained the fixed-patch contract.

Green proof:

```text
npx tsx --test runner-v2/test/node-version.test.ts
npx tsx scripts/test-native-build-policy.mts
npx tsx scripts/test-native-build-cutover.mts
npx tsx scripts/test-deploy-runner-artifacts.mts
```

All named checks passed. The exact fixed-patch fault and an unsupported release-line acceptance fault were reintroduced temporarily; the corresponding policy/package/artifact tests went red, then only those injected edits were reverted and the same checks returned green.

### P1.1 — acceptance contract validators

Commit: `847cc4cd runner-v2: add acceptance evidence contracts`

Added `runner-v2/src/acceptance-contracts.ts` and its tests. The contract defines stable criterion IDs and text, criterion evidence links, Architect review verdicts, duplicate detection, exact coverage, and ownership/artifact validation. Evidence is never interpreted as a semantic verdict.

Pre-change proof:

```text
npx tsx --test runner-v2/test/acceptance-contracts.test.ts
```

The newly added test module failed before the module existed (`Cannot find module '../src/acceptance-contracts.js'`).

Green proof: the same named test passed after implementation. Removing the exact-coverage/duplicate/ownership guard caused the acceptance-contract test to report missing expected rejection; the guard-only edit was reverted and the named test returned green.

### P1.2 — task criteria persistence and graph rules

Commit: `2872f430 runner-v2: persist task acceptance criteria`

Extended `BuildTask`, `plan_tasks`, task revision/reconciliation, graph validation, and scheduler persistence. New non-cancelled tasks require at least one non-empty unique criterion; criteria are versioned and cannot mutate through an active-attempt transition.

Pre-change proof:

```text
npx tsx --test runner-v2/test/task-graph.test.ts runner-v2/test/guidance-review.test.ts
```

The pre-change run had 13 passes and 2 failures: a task without criteria was accepted (`true !== false`) and an empty plan criterion set was not rejected (`false !== true`).

Green proof: the named task-graph/guidance/acceptance checks passed after implementation. A temporary fault allowed a task revision during an active attempt; the guidance test went red with the expected active-revision assertion (`expected true, actual false`). Only that guard fault was reverted; the same named test returned green.

### P1.3 — submission criterion evidence

Commit: `6cf7d520 runner-v2: bind submissions to criterion evidence`

Extended `submit_task`, `ChangeSet`, evidence stores/tools, and the native worker path. Every criterion must have exactly one durable evidence mapping. The kernel checks evidence record existence, run/task/actor/current-attempt ownership, and that every cited artifact hash is recorded by the evidence fact; artifact hashes alone cannot impersonate evidence.

Pre-change proof:

```text
npx tsx --test runner-v2/test/change-set.test.ts
```

The new submission tests had two failures because omitted mappings and foreign/stale ownership were not rejected (`Missing expected exception`).

Green proof:

```text
npx tsx --test runner-v2/test/change-set.test.ts runner-v2/test/worker-runtime.test.ts runner-v2/test/evidence-tools.test.ts
```

All named checks passed. Temporarily disabling `assertCriterionEvidenceCoverage` made the omitted-mapping and ownership tests fail red; only that injected call was restored, and the same tests returned green.

### P1.4 — Architect criterion verdicts

Commit: `0e3c40f7 runner-v2: persist criterion review verdicts`

Extended `review_task`, `ReviewProjection`, Architect context/prompts/runtime, and review reducers. Every criterion requires one verdict, rationale, and cited evidence; approval is mechanically rejected for incomplete coverage, while rejection evaluates every criterion and preserves unsatisfied IDs.

Pre-change proof:

```text
npx tsx --test runner-v2/test/guidance-review.test.ts runner-v2/test/native-architect-runtime.test.ts
```

The new review/verdict expectations failed against the pre-verdict implementation. After implementation, the targeted acceptance/guidance/Architect set passed with 22/22 tests.

Green proof:

```text
npx tsx --test runner-v2/test/acceptance-contracts.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/native-architect-runtime.test.ts
```

All 22 tests passed. Removing the expected-criterion-ID coverage loop caused the acceptance/guidance suite to go red: omitted review coverage was not rejected and the expected regression assertion reported `false !== true`. Only the loop fault was reverted; the same suite returned green.

### P1.5 — append-only legacy upgrade gate

Commit: `210a7ae7 runner-v2: gate legacy runs for acceptance upgrade`

Added append-only `acceptance_contract.upgrade_required` and `acceptance_contract.upgraded` events. Active legacy plans enter `acceptance_contract_upgrade_required`; the Build runtime records one gate and invokes the Architect upgrade path. Worker submission and Architect review/completion are blocked until criteria are supplied for every non-cancelled task. Completed legacy plans remain replayable/inspectable and are marked `legacy_completed` rather than being rewritten.

Pre-change proof:

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
```

The pre-change run had 9 passes and 2 failures: expected active legacy status `acceptance_contract_upgrade_required` and completed legacy status `legacy_completed` were `undefined`.

Green proof:

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/recovery-smoke.test.ts
```

All 41 tests passed. The suite covers exactly-one gate idempotency, replay of completed legacy runs, corrupt upgrade payload rejection/atomicity, restart/recovery, and submit/review authority gates. A temporary reducer fault changed the upgrade status to `current`; the scheduler suite went red with 10 passes and 1 failure (`Missing expected exception` at the submission gate). Only that status assignment was reverted and the same 41-test set returned green.

### P1.6 — client, audit, task board, and observability projections

Commit: `dd401475 runner-v2: expose acceptance contracts in client surfaces`

Projected authoritative criteria, versions, mechanical evidence links, and separate Architect verdicts through `lib/client/runner-v2.ts`, `/build/audit`, the Build task board, the Runner V2 observability panel, and the live discussion adapter. The UI explicitly distinguishes submitted evidence from semantic Architect verdicts and renders legacy upgrade status.

Pre-change proof:

```text
npx tsx scripts/test-runner-v2-client.mts
npx tsx scripts/test-build-task-board-ui.tsx
npx tsx scripts/test-runner-v2-observability.mts
npx tsx --test runner-v2/test/control-server.test.ts
```

The client test failed because `projectNativeAcceptanceContract` was missing; the task-board test failed because criterion text was absent; the observability test failed because its projection helper was missing; and the control test failed because `audit.acceptanceContract` was `undefined`.

Green proof:

```text
npx tsx scripts/test-runner-v2-client.mts
npx tsx scripts/test-build-task-board-ui.tsx
npx tsx scripts/test-runner-v2-observability.mts
npx tsx --test runner-v2/test/control-server.test.ts
```

All client/UI checks passed and the control-server suite passed 8/8. The client mapping was temporarily changed to map an empty link array; the client test failed with `Cannot read properties of undefined (reading 'evidenceId')`. After reverting only that fault, client and observability checks were green. The audit projection was then temporarily replaced with an empty task map; the control test failed its deep-equality parity assertion. Reverting only that server fault restored the 8/8 control suite and audit parity.

## Review fix round 1 — R1/R2/R5 evidence authority packet

This bounded repair packet addressed only R1, R2, and R5. R3, R4, R6, and R7 remain queued for the next controlled packet.

### Reproduction before edits

- R1 live path: an inline `createChangeSet` probe supplied a same-run/task/attempt record owned by `{ role: "architect", id: "architect" }`; the pre-fix result was `R1 REPRO: accepted foreign Architect evidence changeset_d55ef920...`.
- R2 durable path: an inline SQLite scheduler probe appended a current task submission with `evidenceId: evidence_fabricated` and a fabricated 64-character hash; the pre-fix result was `R2 REPRO: accepted fabricated evidence ID/hash at durable submit` and the fabricated link was present in the replayed projection.
- R5 scale path: an inline SQLite evidence probe recorded 1,001 records; pre-fix `list(..., limit: 1000)` returned 1,000 rows and omitted the valid tail record (`tailPresent: false`).

The exact pre-fix focused test command was:

```text
npx tsx --test runner-v2/test/change-set.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/evidence-tools.test.ts
```

It was red at 18/21: the new actor-ownership test failed with `Missing expected rejection`, the exact lookup test failed with `TypeError: store.getByIds is not a function`, and the durable fabricated-reference test failed with `Missing expected exception`.

### Repair

- Added `EvidenceStore.getByIds` with exact-ID, task/run-scoped, 500-row batched SQLite queries and requested-order results; missing IDs remain absent rather than being substituted by an oldest-rows listing.
- Bound live worker submissions to the assigned worker ID. Exact worker evidence and colon-delimited attributed subagent descendants are accepted; Architect and unrelated worker evidence are rejected.
- Threaded the active attempt into subagent browser/evidence tools so descendant evidence carries the same attempt identity.
- Added authoritative evidence lookup and ownership/hash validation before SQLite scheduler append for submissions, review requests, and review decisions; production factory wiring shares the evidence store with the scheduler store.
- Required task/attempt binding whenever exact evidence records are validated, preserving the mechanical kernel rule.

### Post-repair checks

```text
npx tsx --test runner-v2/test/change-set.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/worker-runtime.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/native-worker-driver.test.ts runner-v2/test/native-architect-runtime.test.ts
```

Result: 52/52 passed.

```text
npm --prefix runner-v2 run typecheck
npm run lint
```

Both passed. The full Runner test glob reached 381/382: all behavioral tests passed; one unrelated Windows cleanup race reported `EPERM` while removing the temporary directory for `build runtime plans, guides, reviews, integrates, and completes across restarts` after its assertions had passed. The isolated affected Build Runtime test was green in the focused slice.

### Required fault-only red proofs

Each injection changed only the guard under test, was run against its focused regression test, and was reverted before the next check:

1. R1: removed the `assignedWorkerId` propagation into `createChangeSet`. `npx tsx --test runner-v2/test/change-set.test.ts` went red at 2/3 with `Missing expected rejection` in the actor-ownership test. Restoring that propagation returned 3/3 green.
2. R2: removed the `validateSchedulerEvidenceEvent` call from `SqliteSchedulerStore.append`. `npx tsx --test runner-v2/test/scheduler-store.test.ts` went red at 11/12 with `Missing expected exception` in the fabricated-reference test. Restoring only that call returned the scheduler test green.
3. R5: temporarily returned an empty result from `SqliteEvidenceStore.getByIds`. `npx tsx --test runner-v2/test/evidence-tools.test.ts` went red at 5/6 with the expected tail-ID mismatch. Restoring only the lookup returned 6/6 green.

No test, evidence, ownership, or append control was weakened. No same-root-cause failure reached governed reclassification or the five-cycle cap in this packet.

### Packet commit

Production/test packet commit: `0657ad86 runner-v2: enforce exact evidence authority`. This report entry is included in the subsequent documentation commit.

## Repair-cycle ledger

The governed repair budget was respected; no same-root-cause check reached the three-cycle reclassification point or the five-cycle cap.

1. P1.5 targeted fixtures: newly gated legacy test fixtures needed criteria/evidence records and deterministic cleanup after the first failed assertion. The fixtures and cleanup were repaired before the P1.5 green gate.
2. Post-P1.6 full suite: four remaining legacy scheduler/native-worker fixtures still omitted current criteria/evidence links. The full-suite red signatures were:
   - `native worker fails over ...`: expected `submitted`, actual `paused`.
   - scheduler concurrency: expected `['a','b']`, actual `[]`.
   - scheduler restart: cleanup `EPERM` after the preceding assertion failure.
   - scheduler lifecycle: `driver.assignments[0]` was undefined.

   The fixture-only repair is commit `1a0345b8 runner-v2: update scheduler acceptance fixtures`; the affected tests then passed 9/9. The two scheduler/native failures share the legacy-fixture root cause and stopped at cycle 2.
3. Repository-wide lint: `npm run lint` reported two deterministic errors in the new acceptance-contract module (empty derived interface and explicit `any`). The minimal type-only repair is commit `6b697260 runner-v2: satisfy acceptance contract lint`; the affected lint, typecheck, and 22 acceptance/guidance/native-worker tests passed.

The production gate, tests, or controls were not weakened in any repair.

## Static, runtime, and published-artifact validation

Local Node 24 evidence:

- `node --version`: `v24.18.0`
- `npm --version`: `11.6.0`
- `git --version`: `2.53.0.windows.1`
- `npm run typecheck:runner-v2`: passed.
- `npm run lint`: passed after the type-only repair.
- `npm run test:runner-v2 --silent`: passed, 379/379 Runner tests plus every client/policy/UI/transcript/observability script.
- `npm run build`: passed. Next compiled successfully, TypeScript completed, and all 20 static pages generated. The only emitted warning was the pre-existing Tailwind module-type warning.
- `npx tsx scripts/test-native-build-files.mts`: passed after refreshing bundles.
- `npx tsx scripts/test-runner-v2-client.mts`: passed after refreshing bundles.
- `npx tsx scripts/test-runner-v2-observability.mts`: passed after refreshing bundles.
- `git diff --check`: passed.

Node 22 evidence:

- `npm exec --yes --package=node@22.13.0 -- node --version`: `v22.13.0`.
- The unflagged smoke command loaded `node:sqlite`, created an in-memory table, inserted/read a value, and closed cleanly: `v22.13.0 node:sqlite unflagged smoke passed`. Node emitted only the expected experimental-feature warning; no `--experimental-sqlite` flag was supplied.
- `npm exec --yes --package=node@22.13.0 -- node node_modules/tsx/dist/cli.mjs --test runner-v2/test/node-version.test.ts`: 2/2 passed.
- `npm exec --yes --package=node@22.13.0 -- node node_modules/tsx/dist/cli.mjs --test runner-v2/test/scheduler-store.test.ts runner-v2/test/control-server.test.ts runner-v2/test/task-scheduler.test.ts`: 22/22 passed.
- `npm exec --yes --package=node@22.13.0 -- node node_modules/typescript/bin/tsc -p runner-v2/tsconfig.json --noEmit`: passed.

The repository CI compatibility matrix remains `[22.x, 24.x]`; current local execution additionally proved the actual floor 22.13.0 and the local 24.18.0 runtime.

## Database, restart, and event evidence

- Scheduler SQLite replay tests reopen persisted runs and preserve monotonic event sequences/idempotency.
- Legacy active plans record one upgrade-required event and reject duplicate gates; the Architect upgrade is append-only and advances the plan revision.
- Corrupt or incomplete upgrade payloads reject before projection mutation, and completed legacy plans remain readable/inspectable without an in-place upgrade.
- Restart/recovery tests preserve attempts, guidance, runtime assignments, provider state, and acceptance status. The control-server SSE test replays only events after the acknowledged sequence.
- Evidence tests persist immutable records with deterministic IDs and verify current task/actor/attempt ownership across submission/review.
- The full suite exercised WAL-backed SQLite stores, close/reopen paths, and temporary runner-owned workspace cleanup. No persistent test state was left in the repository.

## Commit set

```text
b17efb5e runner-v2: support maintained Node LTS lines
847cc4cd runner-v2: add acceptance evidence contracts
2872f430 runner-v2: persist task acceptance criteria
6cf7d520 runner-v2: bind submissions to criterion evidence
0e3c40f7 runner-v2: persist criterion review verdicts
210a7ae7 runner-v2: gate legacy runs for acceptance upgrade
dd401475 runner-v2: expose acceptance contracts in client surfaces
1a0345b8 runner-v2: update scheduler acceptance fixtures
6b697260 runner-v2: satisfy acceptance contract lint
f803fd7d runner-v2: refresh published acceptance bundles
```

`git diff 0c01130ebc85d1d1f17399d49e6957989c95111e..HEAD --stat` reports 62 changed files, 3,530 insertions, and 144 deletions. The final tracked worktree is clean. Only ignored build/dependency/SDD artifacts remain (`.next`, `node_modules`, `out`, generated ignored public runner scripts, `next-env.d.ts`, and this ignored report directory); no unrelated checkout files were touched.

## Remaining risks and explicit boundaries

- P1 does not implement P2 final integration verification, P3 user steering, P4 independent verification, P5 plugins/LSP, P6 certification, or P7 qualification; those phases remain locked.
- Provider calls in this phase use scripted/local test seams; live external-provider qualification remains outside P1.
- The local runtime proof uses Node 22.13.0 and 24.18.0. The semver contract and synthetic rejection matrix cover other maintained-line patch values, but no claim is made that every upstream patch was installed locally.
- The baseline dependency install reported seven pre-existing npm audit findings (one moderate, six high); no Runner-specific impact was found in this phase.

## Review fix round 1 — R3 retry projection packet

This bounded repair addresses only R3. R4, R6, and R7 remain queued; no P2 work was started.

### Reproduction before edits

- Durable reducer/replay: `npx tsx --test runner-v2/test/scheduler-store.test.ts` was red at 12/13. The new retry regression stopped with the old attempt-1 `criterionEvidenceLinks` still present where the current projection was required to be `undefined`.
- Client projection: `npx tsx scripts/test-runner-v2-client.mts` was red with the stale attempt-1 link returned for a task at attempt 2; the expected current link projection was empty.
- The reproducer used a real WAL-backed `SqliteSchedulerStore`, persisted a submitted attempt-1 mapping and rejected Architect verdict, appended the runner retry transition to `planned`, closed/reopened the database, and replayed the events. The stale current task mapping and rejected review survived replay before this packet.

### Repair

- Added explicit `CriterionSubmissionProjection` and attempt/acceptance-criteria-version fields to review projections.
- Scheduler projections now retain immutable `submissionHistory` and `reviewHistory` by task while keeping current task links and current review separate.
- Every submission and completed Architect decision records its task attempt and criterion version in history; history arrays and nested evidence/verdict data are cloned during reducer replay and audit projection.
- A rejected/failed task transitioning back to `planned` clears current worker/change-set/evidence fields and the current review, while preserving both histories. Fresh-attempt task revision also clears the current review.
- Audit output exposes current empty links/verdicts/status after retry plus the versioned historical records.
- Client mapping filters current links/reviews to the task attempt and criterion version, suppresses a review on a planned retry, and maps the same immutable histories without sharing mutable arrays.

### Post-repair checks

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
```

13/13 passed, including the close/reopen reducer and audit assertions.

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts runner-v2/test/guidance-review.test.ts && npx tsx scripts/test-runner-v2-client.mts
```

26/26 scheduler/guidance tests passed and the client contract script returned `PASS runner-v2 client`.

```text
npm run typecheck:runner-v2
npx eslint runner-v2/src/scheduler-store.ts runner-v2/src/task-graph.ts lib/client/runner-v2.ts runner-v2/test/scheduler-store.test.ts scripts/test-runner-v2-client.mts
```

Both static checks passed with exit code 0.

The broader `npm run test:runner-v2` exit attempt reached 383 Runner tests with 381 passing. One failure was the exact audit-shape fixture, which was repaired in this packet; the remaining repeated failure is the pre-existing Windows `EPERM` cleanup race in `build-runtime.test.ts` after its assertions complete. The affected control-server suite is green at 8/8 after the audit fixture update; the focused R3/scheduler/guidance/client checks above are green.

### Required fault-only red proofs

Each injection changed only the R3 guard under test, was run against the focused regression, then was restored before the next proof:

1. Removed task-graph retry clearing (`startsRetry = false`). The scheduler suite went red at 12/13 with the attempt-1 current link still present; restoring the guard returned 13/13.
2. Disabled `appendSubmissionHistory`. The scheduler suite went red at 12/13 with the expected submission history missing; restoring only the append returned 13/13.
3. Disabled `appendReviewHistory`. The scheduler suite went red at 12/13 with the expected rejected review history missing; restoring only the append returned 13/13.
4. Removed the client attempt/version review match guard. The client script went red at the current verdict assertion because the stale attempt-1 rejected verdict was exposed; restoring the guard returned `PASS runner-v2 client`.

No test or control was weakened. No R3 failure reached governed reclassification or the five-cycle cap.

### Packet status

Production/test packet commit: `f9f537bd runner-v2: clear retry acceptance projections`.

The follow-up documentation commit records the final report hash and clean tracked state.

## Review fix round 1 — R4 legacy completion and handoff gate packet

This bounded repair addresses only R4. R6 and R7 remain queued; no P2 work was
started. The existing pre-gate historical-completion replay test was retained:
`completed legacy scheduler runs remain replayable and inspectable`.

### Reproduction before edits

Added a real `SqliteSchedulerStore` regression using the WAL-backed durable
append path. It creates a legacy plan, records the explicit
`acceptance_contract.upgrade_required` gate, then directly appends raw
`run.completed` and `project.handoff_selected` events. Before the reducer guard
was added:

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
14 tests, 13 passed, 1 failed
AssertionError: Missing expected exception
  gated active legacy runs reject raw completion and handoff selection until upgrade
  at runner-v2/test/scheduler-store.test.ts:345
```

The first implementation attempt guarded on the legacy status alone and
correctly exposed an important boundary distinction: a legacy plan has
`acceptanceContractStatus = acceptance_contract_upgrade_required` before the
explicit gate event, so that condition would incorrectly reject valid
historical pre-gate completion and handoff replay. The authoritative gate
marker is the durable `acceptanceUpgradeRequiredEventRecorded` flag.

### Repair

- The scheduler reducer now rejects raw Architect `run.completed` append and
  raw user/runner `project.handoff_selected` append only when both the legacy
  upgrade-required status and the durable explicit gate marker are present.
- The append transaction therefore rolls back the rejected event, preserving
  the active run and requested handoff projection for replay.
- A successful `acceptance_contract.upgraded` event changes the status to
  `current`; completion and handoff selection then append normally.
- Historical completion before the gate remains readable and continues to map
  to `legacy_completed`, preserving the existing replay compatibility rule.

The focused regression exercises both direct durable paths: post-gate raw
completion throws and leaves three events, post-gate handoff selection throws
and leaves `requested`, and each operation succeeds after the Architect
upgrade. Replay verifies the final status is `completed` with a `current`
acceptance contract.

### Post-repair checks

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
14/14 passed

npx tsx --test --test-name-pattern "legacy|exhausted rejected|exhausted failed" runner-v2/test/build-runtime.test.ts
4/4 passed

npx tsx --test runner-v2/test/scheduler-store.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/recovery-smoke.test.ts
30/31 passed; all 14 scheduler tests, the recovery test, and the selected
lifecycle assertions passed. The sole failure was the known Windows EPERM
temporary-directory cleanup race in build-runtime.test.ts after its assertions;
this is the same pre-existing cleanup failure recorded in the R3 packet.

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/scheduler-store.ts runner-v2/test/scheduler-store.test.ts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proofs

Each proof changed only the corresponding R4 guard, ran the focused scheduler
suite, and restored that guard before the next proof:

1. Changed the `run.completed` guard condition to be impossible. The suite
   returned 13/14 with `AssertionError: Missing expected exception` at line
   345. Restoring only the completion guard returned 14/14.
2. Changed the `project.handoff_selected` guard condition to be impossible.
   The suite returned 13/14 with `AssertionError: Missing expected exception`
   at line 404. Restoring only the handoff guard returned 14/14.

No test or control was weakened. No R4 failure reached governed
reclassification or the five-cycle cap. R6/R7 and P2 were not touched.

### Packet status

Production/test packet commit: `3240ba11 runner-v2: gate legacy completion after upgrade`.

The follow-up documentation commit records this report section, the final
report hash, and clean tracked state.

## Review fix round 1 — R6 subpacket A raw scheduler WAL compatibility

This bounded subpacket addresses only the scheduler half of R6. The evidence
schema migration and injected migration rollback remain for the next R6
subpacket. R7 and P2 were not touched.

### Reproduction before edits

The existing legacy scheduler test built its database through
`SqliteSchedulerStore`, so it did not prove compatibility with a database
created before P1. A new test now generates the fixture with raw
`DatabaseSync` SQL: it creates the pre-P1 `scheduler_events` table and index,
inserts fixed legacy `run.policy_configured` and `plan.created` rows directly,
and keeps `PRAGMA journal_mode = WAL` with `wal_autocheckpoint = 0` while the
current store opens the same path. The test asserts the real `scheduler.sqlite-wal`
sidecar exists before current-store open, after the gate append, and while the
store is closed for each reopen.

The fixture test was run immediately against HEAD `13ab6305` before any
production change:

```text
npx tsx --test --test-name-pattern "raw pre-P1 scheduler WAL" runner-v2/test/scheduler-store.test.ts
1/1 passed
```

This verifies that the existing scheduler schema and reducer already accept
the raw pre-P1 shape; no scheduler production migration fix was technically
required. The proof gap was test coverage, not a reproduced scheduler defect.

### Repair and compatibility proof

- The new raw fixture preserves exact event sequence, event IDs, and event
  types (`run.policy_configured` sequence 1 and legacy `plan.created` sequence
  2) through current-store open.
- The active legacy projection enters
  `acceptance_contract_upgrade_required`; appending the gate gives sequence 3.
- A second gate with a distinct idempotency key is rejected by the durable
  reducer, and the persisted event count remains exactly one gate.
- The current store closes and reopens twice while the raw connection keeps the
  WAL sidecar alive. Each reopen returns byte-for-byte equivalent decoded event
  objects and exactly one gate.
- No historical scheduler event is rewritten and no opaque binary fixture was
  added.

### Post-repair checks

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
15/15 passed

npx tsx --test --test-name-pattern "legacy" runner-v2/test/build-runtime.test.ts
2/2 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/scheduler-store.ts runner-v2/test/scheduler-store.test.ts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proof

The relevant duplicate-gate reducer guard was temporarily changed from
`if (next.acceptanceUpgradeRequiredEventRecorded)` to an impossible condition
(`&& false`) and only that injected fault was run against the raw fixture:

```text
npx tsx --test --test-name-pattern "raw pre-P1 scheduler WAL" runner-v2/test/scheduler-store.test.ts
1 test, 0 passed, 1 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
  at runner-v2/test/scheduler-store.test.ts:275:12
```

Restoring only the guard returned the fixture to 1/1, and the full scheduler
suite to 15/15. The repair cycle remained below the governed reclassification
and five-cycle thresholds.

### Packet status

Production/test packet commit: `d1a79bd3 runner-v2: prove raw scheduler WAL recovery`.

The next bounded R6 subpacket must add the raw legacy evidence schema without
`attempt`, prove its migration and idempotent reopen, and exercise migration
rollback/recovery under an injected failure. The report and tracked worktree
were clean after this packet.

## Review fix round 1 — R6 subpacket B raw evidence migration

This bounded subpacket addresses only the raw legacy evidence-schema half of
R6. Injected migration rollback/recovery is explicitly deferred to R6C. R7 and
P2 were not touched.

### Reproduction before edits

The new regression generates a pre-P1 `evidence_records` database directly
with `DatabaseSync` SQL. The schema intentionally omits `attempt`, inserts two
legacy evidence rows with fixed IDs, actors, facts, hashes, and sequence order,
and enables WAL with `wal_autocheckpoint = 0`. The raw connection remains open
while `SqliteEvidenceStore` opens and migrates the same database, proving a
real `evidence.sqlite-wal` sidecar is present across migration and reopen.

The migration behavior was already present at HEAD `d7608bf1`, so the focused
test was green before production edits:

```text
npx tsx --test runner-v2/test/sqlite-evidence-store.test.ts
1/1 passed
```

No production migration defect was reproduced; the missing evidence was the
raw pre-P1 compatibility proof. The test nevertheless has a meaningful
fault-sensitive migration assertion.

### Repair and compatibility proof

- Opening the raw database adds the nullable `attempt` column while retaining
  both legacy rows. `PRAGMA table_info` confirms the migrated column.
- Legacy rows decode with `attempt` omitted/undefined, preserving the nullable
  default; a new post-migration record persists and reopens with `attempt: 2`.
- IDs, facts, artifact hashes, and sequence order remain unchanged.
- Exact `getByIds` lookup returns requested records beyond list semantics,
  preserves requested duplicates, and omits a missing ID.
- The store closes and reopens twice while the raw handle retains the WAL
  sidecar; both reopen projections match the migrated rows exactly.
- No opaque binary fixture or production migration change was added.

### Post-repair checks

```text
npx tsx --test runner-v2/test/sqlite-evidence-store.test.ts
1/1 passed

npx tsx --test runner-v2/test/evidence-tools.test.ts
6/6 passed

npx tsx --test runner-v2/test/scheduler-store.test.ts
15/15 passed

npx tsx --test runner-v2/test/recovery-smoke.test.ts
1/1 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/sqlite-evidence-store.ts runner-v2/test/sqlite-evidence-store.test.ts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proof

The migration branch was temporarily disabled by changing only
`if (!columns.some((column) => column.name === "attempt"))` to an impossible
condition. The focused raw fixture then failed at the migration assertion:

```text
npx tsx --test runner-v2/test/sqlite-evidence-store.test.ts
1 test, 0 passed, 1 failed
AssertionError [ERR_ASSERTION]: current store must migrate attempt
  at runner-v2/test/sqlite-evidence-store.test.ts:28:12
```

Restoring only the migration condition returned the fixture to 1/1 and the
affected evidence, scheduler, and recovery checks to green. The R6B repair
cycle remained below governed reclassification and five-cycle thresholds.

### Packet status

Production change: none; the existing migration is proven by this packet.
Test commit: `f2147e1a runner-v2: prove raw evidence migration`.

R6C remains responsible for an injected failure after the migration step,
transaction rollback, constructor cleanup, and subsequent recovery. The
tracked worktree was clean after this packet.

## Review fix round 1 — R6 subpacket C atomic evidence migration recovery

This bounded subpacket completes the R6 evidence migration proof only. R7 and
P2 were not touched.

### Reproduction before edits

The raw pre-P1 evidence fixture was extended with a deterministic test-only
fault: the test temporarily wraps `DatabaseSync.prototype.exec`, runs the real
`ALTER TABLE evidence_records ADD COLUMN attempt INTEGER`, closes that test
connection, and throws before the store can commit. The wrapper is restored in
the test before any recovery operation; no production bypass or runtime fault
hook is exposed.

Against HEAD `65a8ec19`, before the production change, the focused rollback
test was red with the migration already committed despite the injected failure:

```text
npx tsx --test --test-name-pattern "rolls back after failure" runner-v2/test/sqlite-evidence-store.test.ts
1 test, 0 passed, 1 failed
AssertionError [ERR_ASSERTION]: failed migration must leave the legacy schema unchanged
true !== false
  at runner-v2/test/sqlite-evidence-store.test.ts:117:14
```

### Repair

- The conditional `attempt` column migration now runs inside
  `BEGIN IMMEDIATE`/`COMMIT`, with rollback on every failure.
- Constructor initialization is wrapped so a failed migration closes its
  database handle; an already-closed injected handle is tolerated while the
  original migration error is preserved.
- After rollback, the raw legacy schema has no partial `attempt` column and
  both evidence rows remain readable in their original order. A subsequent
  store open performs the complete migration, preserves nullable legacy
  defaults and exact rows, and a second open is idempotent.

### Post-repair checks

```text
npx tsx --test --test-name-pattern "rolls back after failure" runner-v2/test/sqlite-evidence-store.test.ts
1/1 passed

npx tsx --test runner-v2/test/sqlite-evidence-store.test.ts
2/2 passed

npx tsx --test runner-v2/test/evidence-tools.test.ts
6/6 passed

npx tsx --test runner-v2/test/scheduler-store.test.ts
15/15 passed

npx tsx --test runner-v2/test/recovery-smoke.test.ts
1/1 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/sqlite-evidence-store.ts runner-v2/test/sqlite-evidence-store.test.ts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proof

After the transactional repair, only the migration transaction guard was
fault-disabled by replacing `BEGIN IMMEDIATE` with an impossible condition.
The same injected-failure test returned the expected red result:

```text
npx tsx --test --test-name-pattern "rolls back after failure" runner-v2/test/sqlite-evidence-store.test.ts
1 test, 0 passed, 1 failed
AssertionError [ERR_ASSERTION]: failed migration must leave the legacy schema unchanged
true !== false
```

Restoring only `BEGIN IMMEDIATE` returned the rollback test to 1/1 and the
affected suites above to green. No test or production control was weakened;
the fault injector is test-local and is not a production constructor option.
The R6C repair cycle remained below governed reclassification and five-cycle
thresholds.

### Packet status

Production/test commit: `fc091650 runner-v2: make evidence migration atomic`.

R6 is complete. The tracked worktree was clean after this packet, with no R7
or P2 work started.

## Review fix round 1 — R7 RunnerSetup Node policy rendering

This bounded packet addresses only R7. No P2 work was started, and the final
whole-P1 exit suite remains intentionally deferred for controller packaging.

### Reproduction before repair

`RunnerSetup` placed the Node policy expression in JSX as
`${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}`. JSX therefore rendered the dollar
sign literally before evaluating the expression. A focused static assertion was
added to the existing native Build cutover check, scoped to the exact `LTS
release (...)` text so the legitimate template-literal error message elsewhere
in the component remains allowed.

The pre-repair check went red with the expected assertion:

```text
npx tsx scripts/test-native-build-cutover.mts
AssertionError [ERR_ASSERTION]: Runner setup must render the Node policy expression without a stray dollar sign
  at ...\\scripts\\test-native-build-cutover.mts:22:8
```

### Repair

The JSX text now uses `{NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}` without the
literal `$`. The static guard rejects the exact faulty form
`LTS release (${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}` while preserving the
valid template-literal interpolation used by the runtime connection error.
No Node policy logic, supported-version rule, or runtime behavior changed.

### Post-repair checks

The exact R7 check and affected UI/policy/static checks all passed:

```text
npx tsx scripts/test-native-build-cutover.mts
PASS native Build cutover

npx tsx scripts/test-native-build-policy.mts
PASS native Build policy

npx tsx scripts/test-native-build-policy-ui.tsx
PASS native Build policy UI

npx tsx scripts/test-build-task-board-ui.tsx
PASS build task board UI

npx tsx scripts/test-runner-v2-client.mts
PASS runner-v2 client

npx tsx scripts/test-runner-v2-observability.mts
PASS Runner V2 observability panel

npm run typecheck:runner-v2
passed

npx eslint components/RunnerSetup.tsx scripts/test-native-build-cutover.mts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proof

Only the repaired JSX marker was reintroduced temporarily, changing
`{NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}` back to
`${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}`. The same static check went red:

```text
npx tsx scripts/test-native-build-cutover.mts
exit_code=1
AssertionError [ERR_ASSERTION]: Runner setup must render the Node policy expression without a stray dollar sign
  at ...\\scripts\\test-native-build-cutover.mts:22:8
```

Restoring only the JSX marker returned the check to:

```text
npx tsx scripts/test-native-build-cutover.mts
PASS native Build cutover
```

The R7 repair cycle remained below governed reclassification and five-cycle
thresholds. No test or control was weakened.

### Round-1 findings coverage summary (R1–R7)

All seven review findings were technically confirmed and repaired in bounded
packets; no finding remains unconfirmed or unresolved. The final whole-P1 exit
suite is a controller-owned gate and was not rerun in this R7-only packet.

| Finding | Confirmed repair and evidence |
| --- | --- |
| R1 | Live change-set evidence now requires the assigned worker or a proper descendant; adversarial ownership tests reject foreign actors. |
| R2 | The authoritative scheduler append boundary validates exact evidence existence and ownership before durable append; fabricated IDs/hashes are rejected. |
| R3 | Retry projections are attempt/criterion-version scoped: a rejected attempt clears only current submissions/reviews, while immutable prior history survives replay, close/reopen, and client mapping. |
| R4 | After `acceptance_contract_upgrade_required`, raw `run.completed` and handoff selection are rejected until upgrade succeeds; pre-gate historical completion replay remains readable. |
| R5 | Exact batched evidence lookup is uncapped and ID-based, including missing, duplicate, mismatched, and records beyond the prior 1,000-row limit. |
| R6 | Raw pre-P1 SQLite scheduler/evidence fixtures exercise real WAL sidecars, legacy schema migration/defaults, event ordering, idempotent reopen, and transactional migration rollback/recovery. |
| R7 | `RunnerSetup` no longer renders a stray `$` before the Node policy description, and the cutover static check guards the exact JSX form. |

### Packet status

Production/test commit: `4828d4b6 runner-v2: remove setup policy marker`.

This R7 report entry is included in the subsequent documentation commit. The
tracked worktree is clean after that commit, with only ignored SDD artifacts
outside tracked-state checks as permitted. P2 remains untouched.

## Review fix round 2 — R1 assigned-worker authority

This bounded packet addresses only R1 from the round-2 re-review. R2 remains
deferred to its own packet; P2 was not started.

### Reproduction before repair

The reviewer probe was confirmed at the direct durable scheduler boundary. A
current criterion task could be assigned with only `attempt`, leaving
`assignedWorkerId` absent. In the same run, a valid same-task/same-attempt
evidence record attributed to `{ role: "architect", id: "architect_1" }` could
then be submitted and projected as submitted because the optional owner set
was treated as unrestricted.

The focused regressions were written before production edits. Against
`7b88e0d9`, the scheduler check went red with the expected missing guards:

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
18 tests
16 passed
2 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
  durable current criterion assignment requires an assigned worker identity
  at runner-v2/test/scheduler-store.test.ts:654:12
AssertionError [ERR_ASSERTION]: Missing expected exception.
  durable submission rejects legacy worker absence after acceptance upgrade
  at runner-v2/test/scheduler-store.test.ts:739:12
```

The first failure demonstrated that a current evidence-capable assignment
could omit its accountable worker. The second demonstrated that an active
legacy assignment could carry that absence through the acceptance upgrade and
accept Architect-owned evidence at submission.

### Repair

- Added a fail-closed `requiredAssignedWorkerId` invariant for non-empty worker
  identity.
- Current criterion assignments now reject missing or whitespace-only
  `assignedWorkerId` before the scheduler event is durable.
- Current criterion submissions, review requests, and review decisions reject
  missing worker ownership in both the pure reducer and the durable evidence
  validator. The validator now always passes the established owner into the
  existing assigned-worker/descendant check.
- Historical legacy tasks without acceptance criteria remain readable and can
  pass the explicit upgrade gate. If such an active task reaches current
  acceptance criteria without a worker identity, its evidence submission is
  rejected rather than using legacy absence as an authority bypass.

The direct durable regressions cover missing assignment identity, post-upgrade
submission with Architect evidence, unrelated worker evidence, the assigned
worker, and a properly attributed `worker_current:call_1` descendant. Rejected
submission attempts leave the task running and do not append an event; rejected
assignments leave the task planned and do not append an event.

### Post-repair checks

```text
npx tsx --test runner-v2/test/scheduler-store.test.ts
18/18 passed

npx tsx --test runner-v2/test/change-set.test.ts
3/3 passed

npx tsx --test runner-v2/test/evidence-tools.test.ts
6/6 passed

npx tsx --test runner-v2/test/task-scheduler.test.ts
3/3 passed

npx tsx --test runner-v2/test/acceptance-contracts.test.ts
3/3 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/scheduler-store.ts runner-v2/test/scheduler-store.test.ts
passed

git diff --check
passed (only normal CRLF normalization warnings from Git)
```

### Required fault-only red proof

After the repair, only the assignment invariant call was fault-removed. The
focused regression returned the expected red result:

```text
npx tsx --test --test-name-pattern "durable current criterion assignment requires an assigned worker identity" runner-v2/test/scheduler-store.test.ts
1 test
0 passed
1 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
  at runner-v2/test/scheduler-store.test.ts:654:12
```

Restoring only that invariant call returned the focused R1 set to 3/3 and the
full scheduler store suite to 18/18. No test or authority control was
weakened, and no repair cycle reached governed reclassification or the
five-cycle cap.

### Packet status

Production/test commit: `e527bcef runner-v2: require worker identity for criterion evidence`.

R2 remains the next separately bounded repair. The tracked worktree is clean
after the documentation commit, with only ignored SDD artifacts permitted;
`progress.md` was not edited and P2 remains untouched.

## Review fix round 2 — R2 authoritative evidence replay

This bounded packet completes the round-2 R2 repair. It makes evidence
validation fail closed at the SQLite scheduler append and read/replay
boundaries, adds raw-database adversarial reopen coverage, and updates only
affected acceptance fixtures. R1 was already complete in `e527bcef`; P2 was
not started.

### Reproduction before edits

The reviewer’s durable replay probe was reproduced from HEAD `41b9b8d7` by
adding a raw SQLite fixture that inserted a current criterion submission with
`evidenceId: evidence_missing_on_reopen`, while the real evidence store was
empty. The focused test was run before the scheduler-store change:

```text
npx tsx --test --test-name-pattern "raw scheduler replay rejects missing evidence" runner-v2/test/scheduler-store.test.ts
1 test
0 passed
1 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
  at runner-v2/test/scheduler-store.test.ts:355:12
```

The companion append-boundary regression was also red before the guard:

```text
npx tsx --test --test-name-pattern "append fails closed when acceptance evidence lacks" runner-v2/test/scheduler-store.test.ts
1 test
0 passed
1 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
```

The raw fixture uses `DatabaseSync` SQL rather than a current store
constructor: it creates the legacy-shaped `scheduler_events` table and index,
enables WAL with `wal_autocheckpoint = 0`, inserts fixed event IDs and exact
sequences, and keeps the raw connection open so the real `scheduler.sqlite-wal`
sidecar is present. It seeds one missing-evidence run and one valid run backed
by an exact immutable record in `SqliteEvidenceStore`.

### Repair

- `SqliteSchedulerStore.readRun` now loads the complete ordered run, validates
  and reduces every event in sequence, then returns only the requested
  `afterSequence` suffix. Earlier events are therefore available to establish
  the current task attempt, criterion version, and assigned worker before a
  later acceptance event is validated.
- `SqliteSchedulerStore.append` replays prior events through the same
  validator before checking idempotency or reducing the new event. Every
  current acceptance submission, review request, and review decision requires
  an authoritative evidence store; omitting it fails closed before durable
  insertion. Non-acceptance legacy runs remain deterministic and readable.
- Validation continues to resolve exact immutable evidence IDs through
  `EvidenceStore.getByIds`, with run/task scoping and the existing current
  attempt, assigned-worker/descendant, and artifact-hash checks. No oldest-page
  listing is used.
- Raw reopen regressions now reject missing evidence and foreign owner, task,
  attempt, and artifact references before a submitted projection can be
  returned. A valid exact-ID submission reopens twice with an unchanged event
  sequence and `submitted` projection. A raw valid submission followed by an
  invalid review artifact hash fails before a reviewed projection is returned.
- The existing native factory was verified to pass the shared
  `SqliteEvidenceStore` into `SqliteSchedulerStore`. A direct no-store append
  and raw no-store reopen control prove that accidental omission cannot accept
  current evidence events.
- Existing retry/build/scheduler/guidance fixtures were updated only to wire
  real evidence records and assigned worker IDs required by the fail-closed
  boundary. The R3 projection behavior itself was not changed; its close/reopen
  history assertions remain green.

### Post-repair checks

Focused scheduler evidence controls:

```text
npx tsx --test --test-name-pattern "raw scheduler replay rejects missing|append fails closed|raw scheduler replay rejects foreign|raw scheduler replay rejects review" runner-v2/test/scheduler-store.test.ts
4/4 passed

npx tsx --test runner-v2/test/scheduler-store.test.ts
22/22 passed

npx tsx --test runner-v2/test/sqlite-evidence-store.test.ts
2/2 passed

npx tsx --test runner-v2/test/sqlite-event-store.test.ts
3/3 passed

npx tsx --test runner-v2/test/task-scheduler.test.ts
3/3 passed

npx tsx --test runner-v2/test/build-runtime.test.ts
16/16 passed

npx tsx --test runner-v2/test/guidance-review.test.ts
13/13 passed

npx tsx --test runner-v2/test/recovery-smoke.test.ts
1/1 passed

npx tsx --test runner-v2/test/control-server.test.ts
8/8 passed

npx tsx --test runner-v2/test/evidence-tools.test.ts
6/6 passed

npx tsx --test runner-v2/test/native-build-initialization.test.ts
1/1 passed
```

Static and exit checks:

```text
npm run typecheck:runner-v2
passed

npm run lint
passed

npm run test:runner-v2 --silent
394/394 Runner V2 tests passed; all client/policy/UI/pause/model-usage/
live-state/transcript/files/stats/observability scripts passed

git diff --check
passed
```

### Required fault-only red proof

After implementation, only the read-time replay validation call was
fault-disabled by removing `replaySchedulerEvents(events, this.evidenceStore)`
from `readRun`. The raw no-store reopen control then went red:

```text
npx tsx --test --test-name-pattern "raw scheduler replay rejects missing evidence" runner-v2/test/scheduler-store.test.ts
1 test
0 passed
1 failed
AssertionError [ERR_ASSERTION]: Missing expected exception.
  at runner-v2/test/scheduler-store.test.ts:356:14
```

Restoring only that call returned the focused test to 1/1, and the complete
R2 scheduler/adversarial set to 22/22. The same validator path covers the
foreign-owner/task/attempt/hash and review-hash reopen controls, so no
additional production bypass was introduced for those cases.

### Repair-cycle accounting

The R2 packet used one governed repair cycle. The initial missing-evidence
replay and no-store append probes were red before the production change. The
first broad affected run exposed only stale test fixtures that had begun
using current criterion contracts without wiring the authoritative evidence
store or assigned worker IDs; those fixtures were repaired in the same
bounded packet. No identical root cause reached the three-cycle
reclassification point or the five-cycle cap. No tests or controls were
weakened.

### Packet status

Production/test commit: `edfa3483 runner-v2: revalidate evidence on scheduler replay`.

R2 is complete: no R2 finding remains unconfirmed or unresolved. The tracked
worktree was clean before this report update; `progress.md` was not edited,
and P2 remains untouched. The report update is committed separately below.

## Final P1 exit-gate packaging

From HEAD `6f61ef68`, the final P1 build refreshed only
`public/aiboard-runner-v2.zip` and `public/aiboard-workbench-runner.zip`.
The two archives were inspected before publication: each contains the current
SQLite scheduler replay validator, the assigned-worker evidence invariant,
the native factory wiring, and the maintained-LTS package manifest. The
WorkBench archive contains the same files under its nested
`aiboard-runner-v2/` prefix. Normalized archive source bytes match the current
working-tree source for both scheduler files.

Publication and artifact checks:

```text
npm run publish-downloads
exit 0; only the two affected Runner V2 ZIPs changed

npx tsx scripts/test-deploy-runner-artifacts.mts
PASS (publication reproducibility, ZIP contents/manifests, source parity,
     Node LTS policy, account/benchmark exports)

npx tsx scripts/test-native-build-files.mts
PASS native Build files

npx tsx scripts/test-native-build-policy.mts
PASS native Build policy
```

A second `npm run publish-downloads` was byte-stable. SHA-256 values before
and after the second publish were identical:

```text
public/aiboard-runner-v2.zip
C2549D749F74425E5C29BE6FF0A4B855D4DE9860A9738377F33C34FB77313199

public/aiboard-workbench-runner.zip
31A01E09CF471963DC5773D34E03373626CC3EE0F3F082867F8D11F87209C67A
```

No account-provider or benchmark archive was modified. The affected archive
files and this packaging entry are committed in the final P1 gate commit;
`progress.md` remains untouched and P2 was not started.
