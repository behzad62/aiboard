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
