# Atomic Benchmark Results, History, and Provider Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish only complete per-subject benchmark snapshots, show the latest
exact configuration with expandable history instead of lifetime aggregation,
delete whole snapshots safely, and recover temporary provider failures with
bounded backoff in both browser-certified calls and packaged WorkBench Runner V2.

**Architecture:** Add a durable `BenchmarkResultSet` manifest above existing
incrementally persisted runs and attempts. Execution code creates a pending
manifest before paid work, attaches every evidence record by result-set ID, and
publishes one immutable metrics snapshot only after the expected logical
attempts are scoreable. Result-set-first selectors choose the latest completed
snapshot per canonical configuration and keep older snapshots as history;
browser and Runner V2 provider calls share the approved retry semantics through
separately packaged, parity-tested implementations.

**Tech Stack:** Next.js 16 App Router, React 19, strict TypeScript, browser
IndexedDB/folder storage adapters, Node.js 24.18.0 Runner V2, TSX script tests,
Tailwind CSS, Chrome acceptance testing.

## Global Constraints

- Only validated `status: "completed"` result sets enter Results, charts,
  verdicts, profiles, or certified reports.
- A ModelIQ result set is one selected model across the complete GameIQ bundle
  plus complete Tool Reliability suite.
- Independently completed models or team configurations publish even when a
  sibling fails.
- Provider, runner, harness, persistence, budget, cancellation, interruption,
  and missing-case outcomes remain audit-only.
- Honest model/verifier/tool-output failures remain scoreable and can publish a
  low or zero result.
- Separate executions are never averaged.
- History identity includes provider, model, normalized effort, effective
  max-token configuration, versioned promised track bundle, scoring version,
  and exact ordered team roles/strategy.
- Temperature is ignored.
- Latest ordering is `completedAt` descending with result-set ID as tie-breaker.
- Deltas compare Overall Index and pass rate only with the immediately previous
  completed comparable snapshot.
- Inline history initially shows five older snapshots and reveals five more per
  `Show more`.
- All completed snapshots are retained until whole-snapshot deletion or clear
  all.
- Legacy attempts without a valid completed manifest never enter Results.
- Retry schedule is original call, then 2s, 5s, 15s, 30s, and 60s with
  plus/minus 20 percent jitter.
- A longer typed `Retry-After` wins only when it fits the remaining wall-clock
  budget.
- Retry sleeps are cancelable, token-free, keep their admitted concurrency
  slot, and never overlap an unconfirmed physical call.
- Authentication, authorization, billing, depleted credits, hard quota,
  missing model, invalid request, benchmark budget, cancellation, verifier, and
  model-output failures are not retried.
- Every physical attempt remains traceable and contributes returned usage to
  token/cost/call efficiency.
- Same-tab navigation and inactivity do not cancel a benchmark.
- Account-provider credentials are never placed in source, tests, screenshots,
  reports, commits, or final prose.
- Runner V2 remains pinned to exactly Node.js 24.18.0.
- Account-provider runner stays protocol/version `19` unless an incompatible
  protocol change is separately required; additive retry metadata is version-19
  compatible.
- Product Build mode must not import
  `lib/client/legacy-build-engine.benchmark.ts`.
- If Runner V2 or account-provider source changes, regenerate and verify the
  published WorkBench/account-provider artifacts before browser testing.
- Stop the development server before `npm run build`; restart it for Chrome
  acceptance.
- Finish with automated verification, independent Tier 3 reviews, a real Chrome
  ModelIQ run using GPT-5.6 Luna/Terra/Sol at Medium, and a clean local merge to
  `main`.
- Do not push or open a pull request.

## File and Responsibility Map

### New files

- `lib/benchmark/certified/result-set-identity.ts` — canonical configuration,
  stable key generation, and versioned expected-attempt identities.
- `lib/benchmark/certified/result-set-publication.ts` — pending creation,
  ownership validation, intrinsic metric materialization, publish/fail/cancel,
  and stale reconciliation.
- `lib/benchmark/certified/result-set-selectors.ts` — validated latest/history
  series, deltas, audit rows, and snapshot-scoped evidence selection.
- `lib/benchmark/certified/retry-policy.ts` — browser-certified retry constants,
  jitter, deadline calculation, and cancelable sleep runtime.
- `runner-v2/src/provider-call-retry.ts` — standalone Runner V2 equivalent of
  the approved retry policy.
- `components/benchmark/results/ResultHistoryRows.tsx` — desktop/mobile inline
  history rail, deltas, pagination, profile, and delete controls.
- `components/benchmark/BenchmarkResultSetAudit.tsx` — Data-tab result-set
  status/usage audit table.
- `components/benchmark/useBenchmarkResultSetDeletion.ts` — one guarded
  whole-snapshot deletion flow shared by Results and audit surfaces.
- `scripts/test-benchmark-result-set-identity.mts` — identity and series unit
  regressions.
- `scripts/test-benchmark-result-set-storage.mts` — store, run-file,
  import/export, clear, and tombstone deletion regressions.
- `scripts/test-benchmark-result-set-publication.mts` — Advanced/ModelIQ
  publication and failure-containment regressions.
- `scripts/test-benchmark-team-result-publication.mts` — TeamIQ/WorkBench
  independently completed subject regressions.
- `scripts/test-benchmark-latest-history.mts` — latest-only scoring, deltas,
  same-execution lift, legacy hiding, and report regressions.
- `scripts/test-benchmark-result-history-ui.tsx` — responsive inline-history,
  profile, pagination, and deletion UI regressions.
- `scripts/test-benchmark-result-set-audit-ui.tsx` — Data audit statuses and
  usage regressions.

### Existing files changed by responsibility

- `lib/benchmark/types.ts` — additive result-set schema and optional ownership
  IDs on legacy-compatible evidence records.
- `lib/client/store.ts` — in-memory result-set collection, persistence merge,
  getters/upserts/removals, and clear-all accounting.
- `lib/benchmark/store.ts` — result-set save/list/import/export, anchor-run file
  persistence, completed-record immutability, and cascade deletion.
- `lib/benchmark/redaction.ts` — result-set failure/configuration redaction.
- `lib/benchmark/certified/run-context.ts` — result-set ownership lookup and
  retry progress contract.
- `lib/benchmark/certified/run-persistence.ts` — ownership injection on every
  persisted record and stale result-set reconciliation.
- `lib/benchmark/certified/run-status.ts` — run-to-result-set links.
- `lib/benchmark/certified/run-engine.ts` — ownership maps and result-set-aware
  callbacks.
- `lib/benchmark/certified/run-execution.ts` — execution/result planning,
  ModelIQ cross-leg manifests, peer containment, and terminalization.
- `lib/benchmark/teamiq/certified-runner.ts` and
  `lib/benchmark/fireworks/certified-runner.ts` — per-composition completion
  callbacks after owned evidence settles.
- `lib/benchmark/certified/model-call.ts` and
  `lib/benchmark/certified/classify-provider-failure.ts` — typed retry policy,
  structured metadata, deadline checks, and progress.
- `lib/providers/base.ts` and `lib/providers/account-runner.ts` — additive
  stream error metadata and account-runner `Retry-After`.
- `lib/account-provider-runner.mjs` — propagate upstream retryable HTTP
  status/`Retry-After` without exposing credentials.
- Certified track runners under `lib/benchmark/gameiq/`,
  `lib/benchmark/toolreliability/`, `lib/benchmark/teamiq/`, and
  `lib/benchmark/fireworks/` — complete physical-attempt usage accounting.
- `runner-v2/src/agent-loop.ts`, `runner-v2/src/native-worker-driver.ts`, and
  `runner-v2/src/native-architect-runtime.ts` — exact provider-call recovery and
  durable retry progress.
- `lib/benchmark/scoring/types.ts`, `lib/benchmark/scoring/aggregate.ts`,
  `lib/benchmark/metrics.ts`, and certified team-lift selectors — result-set
  grouping and same-execution comparisons.
- `components/benchmark/useBenchmarkDashboard.ts` — load result sets, build
  latest/history dashboard payload, and expose audit rows/counts.
- `lib/benchmark/certified/dashboard-selectors.ts` and
  `lib/benchmark/certified/decision-dashboard.ts` — typed snapshot/history
  rows, deltas, and snapshot-scoped filtering.
- `components/BenchmarkPage.tsx`,
  `components/benchmark/results/BenchmarkDecisionDashboard.tsx`,
  `components/benchmark/results/DecisionLeaderboard.tsx`,
  `components/benchmark/results/ModelEvidenceProfile.tsx`,
  `components/benchmark/certified/CertifiedBenchmarkOverview.tsx`,
  `components/benchmark/certified/CertifiedResultTables.tsx`, and
  `components/BenchmarkLab.tsx` — latest/history presentation, whole-snapshot
  deletion, profile selection, and audit status.
- `lib/benchmark/reports.ts` and
  `components/benchmark/useBenchmarkReportActions.ts` — completed-snapshot-only
  certified reports while raw bundles retain audit evidence.
- `package.json` — register every new focused regression in the benchmark
  aggregate.
- `public/aiboard-account-provider-runner.zip`,
  `public/aiboard-workbench-runner.zip`, and generated export copies when their
  source changes — regenerated artifacts, never hand-edited.

---

### Task 1: Result-set domain, canonical identity, and pure history series

**Files:**

- Create: `lib/benchmark/certified/result-set-identity.ts`
- Create: `lib/benchmark/certified/result-set-selectors.ts`
- Modify: `lib/benchmark/types.ts`
- Create: `scripts/test-benchmark-result-set-identity.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `BenchmarkTrack`, `BenchmarkTeamCompositionRole`,
  `ReasoningEffort`, and the existing normalized-effort helper.
- Produces:

```ts
export type BenchmarkResultSetStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleting";

export interface BenchmarkResultRoleConfiguration {
  role: BenchmarkTeamCompositionRole["role"];
  slot: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  maxTokens: number | null;
}

export interface BenchmarkResultTrackConfiguration {
  track: BenchmarkTrack;
  suiteId: string;
  caseManifest: Array<{
    caseId: string;
    caseVersion: string;
    scoringVersion: string;
  }>;
  maxTokens: number | null;
}

export interface BenchmarkResultConfiguration {
  subjectKind: "model" | "team";
  displayName: string;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: string;
  strategy?: string;
  roles: BenchmarkResultRoleConfiguration[];
  tracks: BenchmarkResultTrackConfiguration[];
}

export interface BenchmarkExpectedResultAttempt {
  runId: string;
  track: BenchmarkTrack;
  suiteId: string;
  caseId: string;
  caseVersion: string;
  scoringVersion: string;
  teamCompositionId: string;
}

export interface CertifiedResultSnapshotMetrics {
  attempts: number;
  passed: number;
  failed: number;
  verifiedPassRate: number | null;
  verifiedQuality: number;
  overallScore: number | null;
  trackBreakdown: Array<{
    track: BenchmarkTrack;
    attempts: number;
    passed: number;
    verifiedPassRate: number | null;
    averageVerifiedQuality: number;
  }>;
  jobSuccessScore: number;
  efficiencyScore: number;
  toolReliabilityScore: number | null;
  toolReliabilitySamples: number;
  costUsd: number | null;
  averageCostUsd: number | null;
  durationMs: number | null;
  costPerPass: number | null;
  speedPerPassMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokensPerPass: number | null;
  costBasis: "usd" | "tokens" | null;
}

export interface BenchmarkResultSet {
  id: string;
  schemaVersion: 1;
  executionId: string;
  anchorRunId: string;
  runIds: string[];
  configurationKey: string;
  configuration: BenchmarkResultConfiguration;
  expectedAttempts: BenchmarkExpectedResultAttempt[];
  status: BenchmarkResultSetStatus;
  createdAt: string;
  completedAt?: string;
  terminalAt?: string;
  failure?: { kind: string; code: string; message: string };
  metrics?: CertifiedResultSnapshotMetrics;
}

export function benchmarkResultConfigurationKey(
  input: BenchmarkResultConfiguration
): string;

export interface BenchmarkResultSeries {
  configurationKey: string;
  latest: BenchmarkResultSet;
  older: BenchmarkResultSet[];
  overallDelta: number | null;
  passRateDelta: number | null;
}

export function selectBenchmarkResultSeries(
  resultSets: readonly BenchmarkResultSet[],
  isValid: (resultSet: BenchmarkResultSet) => boolean
): BenchmarkResultSeries[];
```

- [ ] **Step 1: Write identity and series tests**

Create fixtures for two solo configurations and one ordered-role team. Assert:

```ts
assert.equal(
  benchmarkResultConfigurationKey({
    ...soloConfig,
    displayName: "GPT-5.6 Luna",
  }),
  benchmarkResultConfigurationKey({
    ...soloConfig,
    displayName: "Renamed display label",
  })
);
assert.notEqual(key(soloConfig), key({ ...soloConfig, reasoningEffort: "high" }));
assert.notEqual(key(soloConfig), key({ ...soloConfig, providerId: "openai" }));
assert.notEqual(
  key(teamConfig),
  key({ ...teamConfig, roles: [...teamConfig.roles].reverse() })
);
assert.equal(
  key(configurationFromTeam(teamAtTemperatureZero)),
  key(configurationFromTeam(teamAtTemperatureOne))
);
```

Create three completed records with one configuration key and completion
timestamps `10:00`, `11:00`, and `11:00` with IDs `a`, `b`, and `c`. Assert `c`
is latest, history is `[b, a]`, Overall delta is `c.overall - b.overall`, and
pass delta is `c.passRate - b.passRate`. Add pending, failed, cancelled,
deleting, and legacy-unvalidated records and assert they do not enter that
series. Add a valid completed record with a changed scoring version and assert
it forms a separate configuration series rather than entering this history.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npx tsx scripts/test-benchmark-result-set-identity.mts
```

Expected: FAIL because result-set types, key generation, and series selection do
not exist.

- [ ] **Step 3: Add the additive domain schema**

Add the interfaces above to `lib/benchmark/types.ts`. Keep ownership fields out
of legacy evidence types until Task 2. Do not include temperature in
`BenchmarkResultConfiguration`; `configurationFromTeam` must explicitly pick
the listed role fields rather than spreading a role object.

- [ ] **Step 4: Implement canonical identity**

In `result-set-identity.ts`, normalize:

```ts
const canonical = {
  subjectKind: input.subjectKind,
  providerId: input.providerId ?? null,
  modelId: input.modelId ?? null,
  reasoningEffort: normalizeBenchmarkReasoningEffort(input.reasoningEffort),
  strategy: input.strategy ?? null,
  roles: input.roles.map((role) => ({
    role: role.role,
    slot: role.slot,
    providerId: role.providerId,
    modelId: role.modelId,
    reasoningEffort: normalizeBenchmarkReasoningEffort(role.reasoningEffort),
    maxTokens: role.maxTokens,
  })),
  tracks: [...input.tracks]
    .map((track) => ({
      ...track,
      caseManifest: [...track.caseManifest].sort((a, b) =>
        `${a.caseId}:${a.caseVersion}:${a.scoringVersion}`.localeCompare(
          `${b.caseId}:${b.caseVersion}:${b.scoringVersion}`
        )
      ),
    }))
    .sort((a, b) => `${a.track}:${a.suiteId}`.localeCompare(`${b.track}:${b.suiteId}`)),
};
```

Use stable recursive object-key sorting plus FNV-1a and return
`result-config-v1:<hex>`. Retain canonical equality data on the result set so
selectors can compare the canonical object after a hash match.

- [ ] **Step 5: Implement deterministic completed-series selection**

Filter through `isValid`, require `status === "completed"`, finite parseable
`completedAt`, and non-null `metrics`; group by key; verify canonical equality;
sort by descending time then descending ID; compute deltas only against
`older[0]`.

- [ ] **Step 6: Register and pass the focused test**

Add the script near the other benchmark unit scripts in
`test:benchmark:unit`. Run:

```powershell
npx tsx scripts/test-benchmark-result-set-identity.mts
npm run test:benchmark:unit
```

Expected: PASS.

- [ ] **Step 7: Self-review and commit**

Check that display name and temperature do not alter identity, role order does,
and no execution timestamp or ID enters the key.

```powershell
git diff --check
git add lib/benchmark/types.ts lib/benchmark/certified/result-set-identity.ts lib/benchmark/certified/result-set-selectors.ts scripts/test-benchmark-result-set-identity.mts package.json
git commit -m "feat(benchmark): define atomic result snapshots"
```

---

### Task 2: Durable result-set storage, import/export, and cascade deletion

**Files:**

- Modify: `lib/benchmark/types.ts`
- Modify: `lib/client/store.ts`
- Modify: `lib/benchmark/store.ts`
- Modify: `lib/benchmark/redaction.ts`
- Modify: `components/benchmark/useBenchmarkReportActions.ts`
- Create: `scripts/test-benchmark-result-set-storage.mts`
- Modify: `scripts/test-benchmark-run-file-storage.mts`
- Modify: `scripts/test-benchmark-report-v2.mts`
- Modify: `scripts/test-benchmark-delete-results.mts`
- Modify: `scripts/test-benchmark-clear-all.mts`
- Modify: `scripts/test-benchmark-redaction.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `BenchmarkResultSet` and canonical configuration from Task 1.
- Produces:

```ts
export async function listBenchmarkResultSets(): Promise<BenchmarkResultSet[]>;
export async function saveBenchmarkResultSet(
  record: BenchmarkResultSet
): Promise<void>;
export async function deleteBenchmarkResultSetCascade(
  resultSetId: string
): Promise<BenchmarkDeleteSummary>;
export async function resumeDeletingBenchmarkResultSets(): Promise<number>;
```

- `BenchmarkReportBundleV2.resultSets?: BenchmarkResultSet[]` remains optional
  for version-2 legacy imports; new exports always include it.
- New evidence fields are optional for legacy compatibility:
  `resultSetId?: string` on attempt, verifier, artifact, failure, trace, run
  event, and tool-call trace; `resultSetIds?: string[]` on `BenchmarkRun`.

- [ ] **Step 1: Write storage lifecycle tests**

Use the real client-store test adapter. Cover:

```ts
await saveBenchmarkResultSet(pending);
assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.id), ["set-1"]);
assert.equal(
  JSON.parse(runBlobs.get(pending.anchorRunId)!).resultSets[0].status,
  "pending"
);

await saveOwnedAttempt({ ...attempt, resultSetId: pending.id });
await saveBenchmarkResultSet(completed);
assert.equal(
  JSON.parse(runBlobs.get(pending.anchorRunId)!).resultSets[0].status,
  "completed"
);
```

Assert evidence run blobs are written before the completed anchor marker by
capturing adapter write order. Assert a bundle without `resultSets` imports but
its attempts remain unmanifested. Assert export includes all statuses and
redacts secret-looking failure/configuration strings.

For deletion, create two result sets sharing one run, mark one completed, delete
it, and assert only its owned records disappear. Inject a failure after
`status: "deleting"` is persisted; reset the store, run
`resumeDeletingBenchmarkResultSets`, and assert cleanup completes while the row
was never publishable.

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```powershell
npx tsx scripts/test-benchmark-result-set-storage.mts
npx tsx scripts/test-benchmark-run-file-storage.mts
npx tsx scripts/test-benchmark-report-v2.mts
npx tsx scripts/test-benchmark-delete-results.mts
```

Expected: the new test fails for missing collection/APIs and existing tests
identify bundle shape/count assumptions requiring additive updates.

- [ ] **Step 3: Add ownership fields and the client collection**

Add `benchmarkResultSets: BenchmarkResultSet[]` to `ClientStore`,
`DEFAULT_STORE`, benchmark field merge/strip/load helpers, getters/upserts, and
clear-all counting. Preserve live array references as current benchmark getters
do.

Do not infer result-set IDs for old records.

- [ ] **Step 4: Persist manifests through their anchor run files**

Update `buildBenchmarkRunBundle(runId)` to include only result sets whose
`anchorRunId === runId`. Include `resultSets.length > 0` in
`hasBenchmarkRunEvidence`. `saveBenchmarkResultSet` persists every referenced
evidence run first when completing, then persists `anchorRunId` last.

Reject these illegal mutations:

```ts
completed -> pending
completed -> failed
completed metrics/configuration changes
failed -> completed
cancelled -> completed
```

Allow any persisted result-set status to transition to `deleting` for guarded
whole-snapshot cleanup, plus idempotent saves of byte-equivalent terminal
records.

- [ ] **Step 5: Add import, export, validation, and redaction**

New raw exports always include `resultSets`. Import treats missing
`resultSets` as `[]`, validates array keys and structural fields when present,
and keeps an existing immutable completed record on ID collision. Add result
sets to bundle hashing and import category summaries.

Redact `failure.message` and string values inside configuration metadata through
the existing secret detector. Configuration identity fields remain visible
unless they match a secret pattern.

- [ ] **Step 6: Implement tombstone-first whole-snapshot deletion**

`deleteBenchmarkResultSetCascade` must:

1. persist `{ ...set, status: "deleting", terminalAt }`;
2. collect owned attempt IDs and affected run IDs;
3. delete every record by `resultSetId`, with attempt-ID fallback for owned
   verifier/trace/tool records;
4. remove this ID from shared run `resultSetIds`;
5. delete an owned run only when no sibling result set references it;
6. rewrite/delete affected run blobs;
7. remove the manifest last; and
8. flush.

Extend `BenchmarkDeleteSummary` with `resultSets`. Keep old attempt/run cascade
helpers for raw audit compatibility, but remove them from Results UI in Task 7.

- [ ] **Step 7: Make clear-all and interrupted deletion complete**

Include manifests in `clearAllBenchmarkData`. On store initialization and Data
refresh, `resumeDeletingBenchmarkResultSets` completes tombstones idempotently.
Never publish a deleting record even if child cleanup has not finished.

- [ ] **Step 8: Pass focused and aggregate storage verification**

Run:

```powershell
npx tsx scripts/test-benchmark-result-set-storage.mts
npx tsx scripts/test-benchmark-run-file-storage.mts
npx tsx scripts/test-benchmark-report-v2.mts
npx tsx scripts/test-benchmark-delete-results.mts
npx tsx scripts/test-benchmark-clear-all.mts
npx tsx scripts/test-benchmark-redaction.mts
npm run test:benchmark:unit
```

Expected: PASS.

- [ ] **Step 9: Self-review and commit**

Inspect serialized run blobs and confirm the completed marker is the final
publication write and shared-run deletion cannot remove sibling evidence.

```powershell
git diff --check
git add lib/benchmark/types.ts lib/client/store.ts lib/benchmark/store.ts lib/benchmark/redaction.ts components/benchmark/useBenchmarkReportActions.ts scripts/test-benchmark-result-set-storage.mts scripts/test-benchmark-run-file-storage.mts scripts/test-benchmark-report-v2.mts scripts/test-benchmark-delete-results.mts scripts/test-benchmark-clear-all.mts scripts/test-benchmark-redaction.mts package.json
git commit -m "feat(benchmark): persist atomic result snapshots"
```

---

### Task 3: Result-set publication across Advanced, ModelIQ, TeamIQ, and WorkBench

**Files:**

- Create: `lib/benchmark/certified/result-set-publication.ts`
- Modify: `lib/benchmark/certified/run-context.ts`
- Modify: `lib/benchmark/certified/run-persistence.ts`
- Modify: `lib/benchmark/certified/run-status.ts`
- Modify: `lib/benchmark/certified/run-engine.ts`
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `lib/benchmark/teamiq/certified-runner.ts`
- Modify: `lib/benchmark/fireworks/certified-runner.ts`
- Modify: `lib/benchmark/workbench/certified-runner.ts`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx`
- Create: `scripts/test-benchmark-result-set-publication.mts`
- Create: `scripts/test-benchmark-team-result-publication.mts`
- Modify: `scripts/test-certified-preset-cancellation.mts`
- Modify: `scripts/test-certified-run-engine.mts`
- Modify: `scripts/test-certified-teamiq-partial-persistence.mts`
- Modify: `scripts/test-certified-e2e-workbench-fixture.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 2 list/save APIs and existing certified runner summaries.
- Produces:

```ts
export interface BenchmarkResultSetBinding {
  resultSetId: string;
  runId: string;
}

export interface ResultSetOwnershipMap {
  defaultResultSetId?: string;
  byTeamCompositionId: Record<string, string>;
}

export async function createPendingBenchmarkResultSet(
  input: Omit<BenchmarkResultSet, "status" | "createdAt" | "metrics">
): Promise<BenchmarkResultSet>;

export async function publishBenchmarkResultSetIfComplete(
  resultSetId: string
): Promise<BenchmarkResultSet>;

export async function failBenchmarkResultSet(
  resultSetId: string,
  failure: BenchmarkResultSet["failure"]
): Promise<void>;

export async function cancelBenchmarkResultSet(
  resultSetId: string,
  message: string
): Promise<void>;

export async function reconcileStaleBenchmarkResultSets(input: {
  nowMs?: number;
  hasLiveTabRun: boolean;
}): Promise<number>;
```

- `RunCertifiedBenchmarkInput` gains
  `resultSetOwnership?: ResultSetOwnershipMap` and
  `onSubjectCompleted?: (teamCompositionId: string) => Promise<void>`.
- `CertifiedRunContext` gains
  `resultSetIdForAttempt(attemptId, teamCompositionId?)` and injects ownership
  into every record before save.

- [ ] **Step 1: Write publication/failure-containment tests**

Build test executions with fake certified streams and real in-memory
persistence. Assert:

```ts
// Creation is durable before any paid call.
assert.ok(writeOrder.indexOf("result-set:pending") < writeOrder.indexOf("model-call:start"));

// Honest zero score completes.
assert.equal(zeroScoreSet.status, "completed");
assert.equal(zeroScoreSet.metrics?.overallScore, 0);

// ModelIQ requires both tracks.
assert.equal(afterGameIqOnly.status, "pending");
assert.equal(afterToolReliability.status, "completed");

// Sol infrastructure failure does not hide completed Luna/Terra.
assert.deepEqual(
  sets.map(({ id, status }) => [id, status]),
  [["luna", "completed"], ["terra", "completed"], ["sol", "failed"]]
);
```

Add cancellation after one fully completed model and assert that model remains
completed while unfinished siblings become cancelled. Add a stale pending
record and assert reconciliation skips all pending records while the
tab-lifetime coordinator owns a run, then marks it interrupted after the owner
is idle.

For TeamIQ, complete/persist composition A, throw on B, and assert A publishes
while B fails. Cover solo baseline and team snapshots separately. For WorkBench,
assert a complete pack publishes and runner disconnect/budget failure does not.

- [ ] **Step 2: Run publication tests and verify RED**

Run:

```powershell
npx tsx scripts/test-benchmark-result-set-publication.mts
npx tsx scripts/test-benchmark-team-result-publication.mts
npx tsx scripts/test-certified-teamiq-partial-persistence.mts
npx tsx scripts/test-certified-e2e-workbench-fixture.mts
```

Expected: FAIL because executions have no result-set planning/publication.

- [ ] **Step 3: Implement ownership injection in the run context**

Maintain `attemptId -> resultSetId` when an owner registers. For each record
method, write:

```ts
const resultSetId =
  record.resultSetId ??
  resultSetIdForAttempt(record.attemptId, record.teamCompositionId);
const owned = resultSetId ? { ...record, resultSetId } : record;
```

Run-only artifacts/failures use `defaultResultSetId` only when the run has one
subject. Shared-run records without one owner remain shared and are not deleted
with any single result set.

Persist `BenchmarkRun.resultSetIds` from the unique ownership map.

- [ ] **Step 4: Implement strict completion validation and intrinsic metrics**

`publishBenchmarkResultSetIfComplete` loads owned attempts and requires one
scoreable terminal attempt for every exact expected key:

```ts
`${runId}\0${track}\0${suiteId}\0${caseId}\0${teamCompositionId}`
```

Reject duplicates, missing attempts, and invalid infrastructure statuses.
Accept `passed`, `failed_model`, `failed_verifier`, and `failed_tool_use`.
Materialize intrinsic metrics from only that result set's attempts and
verifiers; omit team lift and deltas. Save metrics, `completedAt`, and completed
status together after all evidence writes.

- [ ] **Step 5: Plan Advanced and ModelIQ manifests before paid work**

Generate one `executionId` when the tab coordinator admits a run.

For Advanced, after cases/teams are known but before the first model call,
create one single-track result set per scoreable subject.

For ModelIQ and the ModelIQ portion of Full Certified:

1. precompute GameIQ and Tool Reliability case manifests;
2. preallocate both run IDs per selected model;
3. create one pending result set per model whose expected attempts span both
   runs;
4. pass the preallocated GameIQ run IDs into `runGameIqMultiModel`;
5. pass each preallocated Tool Reliability run ID into `runSelected`; and
6. call `publishBenchmarkResultSetIfComplete` after each track settles.

If GameIQ infrastructure fails for one model, mark its result set failed and
skip that model's later Tool Reliability leg. A completed zero-score GameIQ
track remains pending and continues to Tool Reliability.

- [ ] **Step 6: Isolate and terminalize every solo peer**

Use all-settled per-model orchestration. One subject failure updates only that
manifest. Parent cancellation cancels pending manifests but never changes a
completed one. At preset exit, reconcile every still-pending planned set to a
sanitized failed/cancelled terminal state.

Progress detail must distinguish `failed benchmark output` from
`unpublished infrastructure failure`.

- [ ] **Step 7: Publish TeamIQ subjects independently**

Move solo-baseline expansion before paid TeamIQ calls so all exact compositions
and manifests exist first. Pass `byTeamCompositionId` into the shared run.

Add `onSubjectCompleted(teamCompositionId)` to both ToolReliability TeamIQ and
Fireworks TeamIQ runners. Invoke it only after every expected attempt, verifier,
tool trace, model trace, and physical cleanup for that composition has
persisted. A later composition failure must not change a previously completed
manifest.

Team-lift linking remains after sibling attempts settle and is not part of
intrinsic publication.

- [ ] **Step 8: Bind WorkBench results to one exact subject manifest**

Create the WorkBench result set only after the runner health gate succeeds and
before the native run starts. Include ordered roles, role effort/max tokens,
strategy/role mode, exact case versions, and Runner V2-backed run ID.

Publish after all pack cases return scoreable attempts. Mark runner disconnect,
timeout, harness invalidity, budget exhaustion, or cancellation unpublishable.

- [ ] **Step 9: Wire stale reconciliation without cancelling active work**

Call `reconcileStaleBenchmarkResultSets` alongside stale run reconciliation.
Pass `hasLiveTabRun:
certifiedTabRunCoordinator.getSnapshot().owner !== null`. Same-tab navigation
and Data-tab refresh therefore never terminalize an active execution.

- [ ] **Step 10: Pass focused execution regressions**

Run:

```powershell
npx tsx scripts/test-benchmark-result-set-publication.mts
npx tsx scripts/test-benchmark-team-result-publication.mts
npx tsx scripts/test-certified-preset-cancellation.mts
npx tsx scripts/test-certified-run-engine.mts
npx tsx scripts/test-certified-teamiq-partial-persistence.mts
npx tsx scripts/test-certified-e2e-workbench-fixture.mts
npm run test:benchmark:e2e
npm run test:gameiq-guards
```

Expected: PASS.

- [ ] **Step 11: Self-review and commit**

Trace one Luna/Terra/Sol ModelIQ execution record-by-record. Confirm pending
manifests precede provider events, no completed marker appears after one leg,
and one model's failure cannot reject the sibling batch.

```powershell
git diff --check
git add lib/benchmark/certified/result-set-publication.ts lib/benchmark/certified/run-context.ts lib/benchmark/certified/run-persistence.ts lib/benchmark/certified/run-status.ts lib/benchmark/certified/run-engine.ts lib/benchmark/certified/run-execution.ts lib/benchmark/teamiq/certified-runner.ts lib/benchmark/fireworks/certified-runner.ts lib/benchmark/workbench/certified-runner.ts components/benchmark/certified/CertifiedRunPanel.tsx scripts/test-benchmark-result-set-publication.mts scripts/test-benchmark-team-result-publication.mts scripts/test-certified-preset-cancellation.mts scripts/test-certified-run-engine.mts scripts/test-certified-teamiq-partial-persistence.mts scripts/test-certified-e2e-workbench-fixture.mts package.json
git commit -m "feat(benchmark): publish complete subjects independently"
```

---

### Task 4: Browser-certified transient recovery, typed Retry-After, and usage accounting

**Files:**

- Create: `lib/benchmark/certified/retry-policy.ts`
- Modify: `lib/benchmark/certified/model-call.ts`
- Modify: `lib/benchmark/certified/classify-provider-failure.ts`
- Modify: `lib/benchmark/certified/run-context.ts`
- Modify: `lib/providers/base.ts`
- Modify: `lib/providers/account-runner.ts`
- Modify: `lib/account-provider-runner.mjs`
- Modify: `lib/benchmark/gameiq/certified-runner.ts`
- Modify: `lib/benchmark/toolreliability/certified-runner.ts`
- Modify: `lib/benchmark/teamiq/certified-runner.ts`
- Modify: `lib/benchmark/fireworks/certified-runner.ts`
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `scripts/test-certified-model-call-retry.mts`
- Modify: `scripts/test-account-provider-runner-chat.mts`
- Modify: `scripts/test-account-provider-runner-copilot-chat.mts`
- Modify: `scripts/test-account-provider-runner-nvidia.mts`
- Create: `scripts/test-certified-provider-retry-accounting.mts`
- Modify: `scripts/test-deploy-runner-artifacts.mts`
- Modify: `package.json`
- Regenerate: `public/aiboard-account-provider-runner.zip`

**Interfaces:**

- Consumes: stable run cancellation, budget start/deadline, result-set ownership,
  and physical teardown from existing `callCertifiedModelOnce`.
- Produces:

```ts
export const CERTIFIED_RETRY_DELAYS_MS =
  [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const CERTIFIED_RETRY_JITTER_RATIO = 0.2;

export interface CertifiedProviderErrorMetadata {
  statusCode?: number;
  code?: string;
  retryAfterMs?: number;
}

export interface CertifiedRetryProgress {
  providerId: string;
  modelId: string;
  participantId: string;
  resultSetId?: string;
  retry: number;
  maxRetries: 5;
  delayMs: number;
  reason: string;
}

export interface CertifiedRetryRuntime {
  now(): number;
  random(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

- `StreamChunk` gains optional
  `errorMetadata?: CertifiedProviderErrorMetadata`.
- `CertifiedProviderError` retains structured status/code/retry-after and
  physical usage.

- [ ] **Step 1: Expand retry tests with a deterministic clock**

Replace real waiting in policy tests with:

```ts
const sleeps: number[] = [];
let now = Date.parse(context.startedAt);
const runtime: CertifiedRetryRuntime = {
  now: () => now,
  random: () => 0.5,
  sleep: async (ms, signal) => {
    if (signal?.aborted) throw signal.reason;
    sleeps.push(ms);
    now += ms;
  },
};
```

Make five transient physical calls fail and the sixth succeed. Assert sleeps
equal `[2000, 5000, 15000, 30000, 60000]`, six unique traces exist, and no two
physical streams overlap.

Add:

- random `0` and `1` jitter-bound assertions;
- `Retry-After: 12` over a 5-second base assertion;
- Retry-After that exceeds remaining wall clock and therefore never sleeps;
- cancellation during each wait with exact reason identity;
- budget checks before and after sleep;
- fatal status/message matrix with one physical attempt;
- no retry after success/returned tool output;
- teardown timeout suppressing retry and keeping ownership locked; and
- sanitized retry-progress payloads.

- [ ] **Step 2: Write cross-track physical usage tests**

For GameIQ, Tool Reliability, TeamIQ, and Fireworks, return one failed physical
usage plus one success:

```ts
retryAttempts: [{
  traceId: "failed-physical",
  latencyMs: 20,
  inputTokens: 100,
  outputTokens: 10,
  estimatedUsd: 0.01,
}]
```

Assert the persisted attempt reports two model calls, 200-style summed usage
including the success, and both trace IDs. Also assert unpublished failed result
sets expose trace token/call totals in audit selection.

- [ ] **Step 3: Run retry/accounting tests and verify RED**

Run:

```powershell
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-certified-provider-retry-accounting.mts
```

Expected: FAIL on delay sequence, jitter semantics, Retry-After, progress, and
non-ToolReliability accounting.

- [ ] **Step 4: Implement the approved retry runtime**

Compute jitter as:

```ts
Math.round(baseMs * (1 + (runtime.random() * 2 - 1) * 0.2))
```

Choose `Math.max(jitteredBase, error.retryAfterMs ?? 0)`. Compute remaining
wall-clock from `context.startedAt`, `context.modelBudget.maxWallClockMs`, and
`runtime.now()`. Throw `CertifiedBudgetExceededError` without sleeping when the
delay cannot fit. Recheck abort and budget after sleep and before the next
physical request.

Keep the admitted model worker slot while sleeping.

- [ ] **Step 5: Preserve structured provider metadata**

Classify using fatal-first structured fields, then message fallback. Accept
typed transient HTTP `429`, `500`, `502`, `503`, and `504`; do not treat `501`
or arbitrary invalid requests as transient.

When account-runner fetch receives an error, emit:

```ts
{
  type: "error",
  error: safeMessage,
  errorMetadata: {
    statusCode: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
  },
}
```

Support both delta-seconds and HTTP-date Retry-After. Reject negative,
non-finite, and malformed values.

- [ ] **Step 6: Propagate upstream metadata through account-provider runner v19**

Introduce a sanitized HTTP error carrying `statusCode` and `retryAfterMs`.
For ChatGPT, Copilot HTTP, and NVIDIA responses, retain upstream retryable status
and Retry-After. `failRequest` forwards only safe status/header/body fields and
never credentials or raw response bodies. SSE errors include the same typed
fields when headers were already sent.

Keep `VERSION = 19`.

- [ ] **Step 7: Emit retry progress through run context and preset UI state**

Call `context.reportRetry?.(event)` immediately before sleeping. Advanced runs
set their status message to:

```text
GPT-5.6 Luna: temporary provider failure; retry 3/5 in 15s.
```

Preset `PresetProgressEvent` gains a retry event tied to the model/result set;
sibling statuses continue updating. Do not persist raw error objects.

- [ ] **Step 8: Centralize physical usage expansion**

Add a helper returning failed physical usages followed by the successful usage.
Update every certified track runner to sum that list for model calls, tokens,
latency, cost, and trace IDs. Remove Tool Reliability's one-off expansion after
all tracks use the shared helper.

- [ ] **Step 9: Prevent multiplicative hidden transport retries where supported**

Add an internal `disableAutomaticRetries?: boolean` to `ChatParams`; certified
calls set it true. OpenAI-compatible and Anthropic SDK constructors use
`maxRetries: 0` for those calls. Discussion calls omit it and retain provider
defaults. Account-runner fetch has no hidden browser retry.

Add source-level/provider-constructor regressions proving certified mode does
not combine SDK retries with the central five-retry policy.

- [ ] **Step 10: Pass browser/account recovery tests**

Run:

```powershell
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-certified-provider-retry-accounting.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
npm run test:benchmark:tracks
npm run test:gameiq-guards
```

Expected: PASS.

- [ ] **Step 11: Regenerate and verify the account-provider artifact**

Run:

```powershell
npm run publish-downloads
npx tsx scripts/test-deploy-runner-artifacts.mts
node --check lib/account-provider-runner.mjs
```

Confirm the embedded source is byte-identical after normalized line endings,
health still reports version 19, and no credential appears in the diff.

- [ ] **Step 12: Self-review and commit**

Inspect every retry exit: fatal, budget, cancellation, teardown failure,
exhaustion, and success. Confirm no path starts another physical request before
the previous iterator/session settles.

```powershell
git diff --check
git add lib/benchmark/certified/retry-policy.ts lib/benchmark/certified/model-call.ts lib/benchmark/certified/classify-provider-failure.ts lib/benchmark/certified/run-context.ts lib/providers/base.ts lib/providers/account-runner.ts lib/account-provider-runner.mjs lib/benchmark/gameiq/certified-runner.ts lib/benchmark/toolreliability/certified-runner.ts lib/benchmark/teamiq/certified-runner.ts lib/benchmark/fireworks/certified-runner.ts lib/benchmark/certified/run-execution.ts scripts/test-certified-model-call-retry.mts scripts/test-certified-provider-retry-accounting.mts scripts/test-account-provider-runner-chat.mts scripts/test-account-provider-runner-copilot-chat.mts scripts/test-account-provider-runner-nvidia.mts scripts/test-deploy-runner-artifacts.mts package.json public/aiboard-account-provider-runner.zip
git commit -m "feat(benchmark): recover transient provider calls"
```

---

### Task 5: Runner V2 exact-call recovery and WorkBench package parity

**Files:**

- Create: `runner-v2/src/provider-call-retry.ts`
- Modify: `runner-v2/src/agent-loop.ts`
- Modify: `runner-v2/src/native-worker-driver.ts`
- Modify: `runner-v2/src/native-architect-runtime.ts`
- Modify: `runner-v2/src/scheduler-store.ts`
- Modify: `runner-v2/src/contracts.ts`
- Create: `runner-v2/test/provider-call-retry.test.ts`
- Modify: `runner-v2/test/agent-loop.test.ts`
- Modify: `runner-v2/test/native-worker-driver.test.ts`
- Modify: `runner-v2/test/native-architect-runtime.test.ts`
- Modify: `scripts/test-workbench-runner-bundle.tsx`
- Modify: `scripts/test-deploy-runner-artifacts.mts`
- Regenerate: `public/aiboard-workbench-runner.zip`

**Interfaces:**

- Consumes: Runner V2 `ProviderTransportError`, `ProviderFailure`,
  `classifyProviderFailure`, model completion request, and cancellation signal.
- Produces:

```ts
export const RUNNER_PROVIDER_RETRY_DELAYS_MS =
  [2_000, 5_000, 15_000, 30_000, 60_000] as const;

export interface RunnerProviderRetryEvent {
  runtimeId: string;
  providerId: string;
  modelId: string;
  retry: number;
  maxRetries: 5;
  delayMs: number;
  reason: string;
  occurredAt: string;
}

export async function completeWithProviderRetry<T>(input: {
  complete: () => Promise<T>;
  signal?: AbortSignal;
  deadlineMs?: number;
  classify(error: unknown): ProviderFailure;
  onRetry?(event: Omit<RunnerProviderRetryEvent, "occurredAt">): void;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T>;
```

- [ ] **Step 1: Write Runner V2 retry policy tests**

Use a fake clock and the same midpoint-jitter sequence as Task 4. Assert:

- transient failures retry at exactly 2/5/15/30/60 seconds;
- longer Retry-After wins;
- cancellation and budget/deadline stop admission;
- auth/billing/hard-quota/missing-model/invalid-request failures do not retry;
- one failed completion never replays prior tool calls;
- six physical model completions are the maximum;
- progress fires before each sleep with sanitized content; and
- the browser and Runner constants are parity-tested.

- [ ] **Step 2: Run Runner tests and verify RED**

Run:

```powershell
npm run test:runner-v2 -- --test-name-pattern="provider call retry"
```

If the aggregate script does not forward the filter, run:

```powershell
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/provider-call-retry.test.ts
```

Expected: FAIL because the retry helper and events do not exist.

- [ ] **Step 3: Implement standalone retry helper**

Keep this file self-contained inside `runner-v2/` so the extracted WorkBench
bundle does not import browser application source. Mirror Task 4's sequence,
jitter, Retry-After precedence, fail-closed cancellation, and deadline logic.

Only retry before `AgentModel.complete` returns a turn. Once a turn's tool calls
enter the ledger, provider retry is no longer involved.

- [ ] **Step 4: Wrap worker and architect model completion**

In `runAgentLoop`, replace the direct completion with
`completeWithProviderRetry`. Pass the identical session ID, compacted messages,
tool definitions, and signal on each physical attempt. The outer worker/router
sees one provider failure only after recovery exhausts.

Budgeted model wrappers remain inside the callback so every physical request
reserves/records its real budget.

- [ ] **Step 5: Persist retry observability**

Add `provider.retry_scheduled` to the scheduler event contract with provider,
model, runtime, retry number, delay, and sanitized reason. Worker and Architect
drivers append it idempotently before the wait. Projection treats it as
progress-only and does not alter run completeness.

Expose the latest event through existing WorkBench/native observability so a
connected benchmark can report that the runner is waiting rather than failed.

- [ ] **Step 6: Pass Runner V2 behavioral tests**

Run:

```powershell
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/provider-call-retry.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/agent-loop.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/native-worker-driver.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/native-architect-runtime.test.ts
npm run typecheck:runner-v2
npm run test:runner-v2
```

Expected: PASS.

- [ ] **Step 7: Regenerate and verify WorkBench Runner V2 package**

Run:

```powershell
npm run publish-downloads
npx tsx scripts/test-workbench-runner-bundle.tsx
npx tsx scripts/test-deploy-runner-artifacts.mts
```

Confirm all packaged `runner-v2/src` files and launcher bytes match source and
the account-provider artifact remains valid.

- [ ] **Step 8: Self-review and commit**

Confirm retry never causes a second Architect/worker lifecycle action, never
replays ledgered tools, and does not turn a hard failure into runtime failover
until the same exact call's transient recovery is exhausted.

```powershell
git diff --check
git add runner-v2/src/provider-call-retry.ts runner-v2/src/agent-loop.ts runner-v2/src/native-worker-driver.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/scheduler-store.ts runner-v2/src/contracts.ts runner-v2/test/provider-call-retry.test.ts runner-v2/test/agent-loop.test.ts runner-v2/test/native-worker-driver.test.ts runner-v2/test/native-architect-runtime.test.ts scripts/test-workbench-runner-bundle.tsx scripts/test-deploy-runner-artifacts.mts public/aiboard-workbench-runner.zip
git commit -m "feat(runner): back off transient model calls"
```

---

### Task 6: Latest-only scoring, history/deltas, same-execution comparisons, and reports

**Files:**

- Modify: `lib/benchmark/certified/result-set-selectors.ts`
- Modify: `lib/benchmark/scoring/types.ts`
- Modify: `lib/benchmark/scoring/aggregate.ts`
- Modify: `lib/benchmark/metrics.ts`
- Modify: `lib/benchmark/certified/team-lift.ts`
- Modify: `lib/benchmark/teamiq/baselines.ts`
- Modify: `lib/benchmark/certified/dashboard-selectors.ts`
- Modify: `lib/benchmark/certified/decision-dashboard.ts`
- Modify: `components/benchmark/useBenchmarkDashboard.ts`
- Modify: `lib/benchmark/reports.ts`
- Create: `scripts/test-benchmark-latest-history.mts`
- Modify: `scripts/test-benchmark-model-effort-aggregation.mts`
- Modify: `scripts/test-benchmark-team-lift.mts`
- Modify: `scripts/test-benchmark-decision-dashboard.mts`
- Modify: `scripts/test-benchmark-report-v2.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: completed result sets and immutable metrics from Tasks 1–3.
- Produces:

```ts
export interface CertifiedResultHistoryRow extends CertifiedRunScore {
  resultSetId: string;
  executionId: string;
  configurationKey: string;
  completedAt: string;
}

export interface CertifiedResultHistorySeriesData {
  configurationKey: string;
  latestResultSetId: string;
  overallDelta: number | null;
  passRateDelta: number | null;
  older: CertifiedResultHistoryRow[];
}

export interface CertifiedBenchmarkDashboardInput {
  resultSets: BenchmarkResultSet[];
  // existing evidence arrays remain
}

export interface CertifiedBenchmarkDashboardData {
  // existing fields remain
  resultHistory: CertifiedResultHistorySeriesData[];
  audit: {
    completedSnapshots: number;
    unpublishedSnapshots: number;
    legacyAttempts: number;
  };
}
```

- `CertifiedLeaderboardRow` gains `resultSetId`, `executionId`,
  `configurationKey`, `completedAt`, `overallDelta`, `passRateDelta`, and
  `historyCount`.

- [ ] **Step 1: Write latest/history and report regressions**

Create two fully completed runs of the same Luna Medium configuration with
different metrics, one failed newer run, one legacy attempt, and one Sol
configuration. Assert:

```ts
assert.equal(rowsForLuna.length, 1);
assert.equal(rowsForLuna[0].resultSetId, "luna-new-complete");
assert.equal(rowsForLuna[0].overallDelta, 0.07);
assert.equal(rowsForLuna[0].historyCount, 1);
assert.deepEqual(historyForLuna.map((row) => row.resultSetId), ["luna-old"]);
assert.ok(!allDecisionEvidenceIds.has("luna-failed-newer-attempt"));
assert.ok(!allDecisionEvidenceIds.has("legacy-attempt"));
```

Create a team snapshot and solo baselines from different `executionId` values
and assert lift is unavailable. Add matching sibling snapshots and assert lift
is calculated. Delete the newest set and assert the old snapshot becomes latest
with no predecessor delta.

Assert certified Markdown/CSV-style report sections list completed snapshots
individually and never lifetime-average them; raw JSON export still contains
failed/legacy evidence.

- [ ] **Step 2: Run selector/scoring tests and verify RED**

Run:

```powershell
npx tsx scripts/test-benchmark-latest-history.mts
npx tsx scripts/test-benchmark-model-effort-aggregation.mts
npx tsx scripts/test-benchmark-team-lift.mts
npx tsx scripts/test-benchmark-decision-dashboard.mts
```

Expected: FAIL because the dashboard still aggregates attempts over time.

- [ ] **Step 3: Validate publishable result sets at read time**

`isPublishableBenchmarkResultSet` requires:

- completed status, timestamp, and metrics;
- exact canonical configuration equality;
- every expected key has exactly one owned scoreable attempt;
- no expected attempt is missing or infrastructure-invalid;
- attempts' scoring/case versions match the manifest; and
- every owned reference exists.

Invalid imported completed markers remain audit-only and add to unpublished
counts.

- [ ] **Step 4: Select latest sets before any scoring**

In `buildCertifiedBenchmarkDashboardData`:

1. validate result sets;
2. select series;
3. collect latest result-set IDs;
4. restrict scoring attempts/verifiers/teams/cases to those IDs;
5. build one base row per result set; and
6. attach immutable metrics and history metadata.

Change `aggregateCertifiedRunScores` grouping to prefer `resultSetId`; never
canonicalize two executions into one row. Keep within-result-set case/track
aggregation.

- [ ] **Step 5: Restrict every decision surface to latest snapshots**

Use latest rows for:

- verdicts;
- leaderboard ranks;
- Pareto frontier;
- tradeoff charts;
- head-to-head;
- model intelligence;
- role leaderboards;
- recommendation cards; and
- summary statistics.

History is available only through `resultHistory` and selected historical
profiles. Provider/harness/user exclusions disappear from Results summaries and
remain in Data audit counts.

- [ ] **Step 6: Enforce same-execution team comparisons**

Thread `executionIdByResultSetId` into TeamIQ/WorkBench baseline linking.
Comparison keys include execution, track, case version, harness/scoring version,
and exact member variant. Never borrow a latest solo row from a different
execution.

Intrinsic team metrics remain frozen; team lift is derived from currently
available completed siblings.

- [ ] **Step 7: Make profile/evidence lookup snapshot-scoped**

Every evidence lookup filters by selected `resultSetId`, not latest attempt or
semantic team ID. Older profiles resolve their own attempts, failures, traces,
versions, tokens, and completion time.

- [ ] **Step 8: Update certified reports without changing raw export**

Certified report builders accept validated result sets, print latest rows and a
clearly labeled history section, and never include incomplete/legacy attempts
in score tables. Raw bundle JSON remains the audit export and includes every
status.

Import copy reports how many result sets were imported and how many qualify as
completed.

- [ ] **Step 9: Pass focused scoring/report tests**

Run:

```powershell
npx tsx scripts/test-benchmark-latest-history.mts
npx tsx scripts/test-benchmark-model-effort-aggregation.mts
npx tsx scripts/test-benchmark-team-lift.mts
npx tsx scripts/test-benchmark-decision-dashboard.mts
npx tsx scripts/test-benchmark-report-v2.mts
npm run test:benchmark:decision
npm run test:benchmark:unit
```

Expected: PASS.

- [ ] **Step 10: Self-review and commit**

Search every certified dashboard/report entry point for direct all-attempt
scoring. Confirm all such paths begin with validated latest result sets or are
explicitly labeled raw audit.

```powershell
git diff --check
git add lib/benchmark/certified/result-set-selectors.ts lib/benchmark/scoring/types.ts lib/benchmark/scoring/aggregate.ts lib/benchmark/metrics.ts lib/benchmark/certified/team-lift.ts lib/benchmark/teamiq/baselines.ts lib/benchmark/certified/dashboard-selectors.ts lib/benchmark/certified/decision-dashboard.ts components/benchmark/useBenchmarkDashboard.ts lib/benchmark/reports.ts scripts/test-benchmark-latest-history.mts scripts/test-benchmark-model-effort-aggregation.mts scripts/test-benchmark-team-lift.mts scripts/test-benchmark-decision-dashboard.mts scripts/test-benchmark-report-v2.mts package.json
git commit -m "feat(benchmark): show latest snapshots without aggregation"
```

---

### Task 7: Inline history, deltas, snapshot profiles/deletion, and Data audit UI

**Files:**

- Create: `components/benchmark/results/ResultHistoryRows.tsx`
- Create: `components/benchmark/BenchmarkResultSetAudit.tsx`
- Create: `components/benchmark/useBenchmarkResultSetDeletion.ts`
- Modify: `components/BenchmarkPage.tsx`
- Modify: `components/BenchmarkLab.tsx`
- Modify: `components/benchmark/results/BenchmarkDecisionDashboard.tsx`
- Modify: `components/benchmark/results/DecisionLeaderboard.tsx`
- Modify: `components/benchmark/results/ModelEvidenceProfile.tsx`
- Modify: `components/benchmark/certified/CertifiedBenchmarkOverview.tsx`
- Modify: `components/benchmark/certified/CertifiedResultTables.tsx`
- Modify: `components/benchmark/results/LensTabs.tsx`
- Modify: `components/benchmark/useBenchmarkDashboard.ts`
- Modify: `components/benchmark/BenchmarkReportSummary.tsx`
- Create: `scripts/test-benchmark-result-history-ui.tsx`
- Create: `scripts/test-benchmark-result-set-audit-ui.tsx`
- Modify: `scripts/test-benchmark-decision-dashboard-ui.mts`
- Modify: `scripts/test-certified-result-ui-viewmodel.mts`
- Modify: `scripts/test-benchmark-delete-results.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: typed latest/history rows, audit rows, and Task 2 deletion API.
- Produces:

```ts
export function useBenchmarkResultSetDeletion(input: {
  onRefresh: () => Promise<void>;
  setMessage: (message: string | null) => void;
}): {
  deletingIds: ReadonlySet<string>;
  deleteInFlight: boolean;
  requestDelete(resultSet: BenchmarkResultSet, label: string): Promise<void>;
};
```

- `BenchmarkDecisionDashboard` receives `onRefresh` and `setMessage`.
- `ResultHistoryRows` receives one latest row, its older rows, selected profile
  ID, and whole-snapshot delete/profile callbacks.

**Approved visual direction:**

- Subject: a local evidence dashboard for people comparing model behavior over
  time; the page's job is to reveal the current result without erasing drift.
- Palette: Night `#020817`, Slate `#0F172A`, Signal blue `#3B82F6`, Gain emerald
  `#10B981`, Loss rose `#F43F5E`, and Evidence mist `#94A3B8`, expressed through
  existing semantic Tailwind tokens where available.
- Type: existing restrained display face for section titles, body face for
  labels/copy, and tabular numerals for metrics; no new global font dependency.
- Layout: the latest result remains the normal leaderboard row. Its expansion
  inserts quieter historical rows directly beneath it on a thin chronological
  rail rather than nesting generic cards inside the table.
- Signature: the history rail aligns completion timestamps and two compact
  change marks, making provider/model drift legible at a glance.
- Restraint review: keep the rest of the dashboard unchanged; no global palette,
  hero, gradient, or ornamental animation change. The one deliberate visual
  accent is the chronological rail. Respect reduced motion.

- [ ] **Step 1: Write responsive UI tests**

Render a latest row with seven older snapshots. Assert:

- `8 runs`/history control has `aria-expanded` and a stable controlled region;
- collapsed state renders no older rows;
- expanded state renders five older rows;
- `Show more` reveals the remaining two in order;
- latest completion time is visible;
- `Overall +7` and `Pass -3 pp` have full accessible labels;
- no predecessor renders no delta;
- older `View profile` opens evidence for its own result-set ID;
- delete targets the selected result-set ID, not an attempt;
- desktop table and mobile cards expose the same history and controls; and
- keyboard focus returns to the invoking control after profile close/delete.

Audit UI fixtures cover pending, completed, failed provider, cancelled,
interrupted, deleting, and legacy counts plus physical calls/tokens.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```powershell
npx tsx scripts/test-benchmark-result-history-ui.tsx
npx tsx scripts/test-benchmark-result-set-audit-ui.tsx
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
```

Expected: FAIL because history/audit components and result-set deletion props do
not exist.

- [ ] **Step 3: Implement one guarded deletion hook**

Confirm with:

```text
Delete the benchmark snapshot for GPT-5.6 Luna completed Jul 29, 2026, 11:00 AM?
This removes its attempts, traces, verifier evidence, and artifacts. Older
snapshots are not affected.
```

Guard concurrent deletion, mark the exact result-set ID busy, call
`deleteBenchmarkResultSetCascade`, refresh, and report promotion:

```text
Deleted the snapshot. The previous completed run is now latest.
```

Use the same hook in the decision dashboard, certified audit lenses, and Data
audit. Remove attempt-level and bulk provider-error removal from Results.

- [ ] **Step 4: Render latest deltas and completion identity**

Under the model/team label, show local completion date/time and bundle/version
when needed. In Overall and Pass cells render signed deltas against the
immediate predecessor:

```text
Overall +7
Pass -3 pp
```

Use emerald/rose plus arrow/text, never color alone. Delta direction always
means higher/lower metric, independent of the current rank selector.

- [ ] **Step 5: Implement inline history rail and pagination**

The history button label uses total runs including latest. Expansion rows are
newest-first, visually subordinate, and carry completion time, full core
metrics, `View profile`, and `Delete snapshot`. Maintain a per-configuration
visible count starting at five and increasing by five.

Use `Fragment` rows with valid table semantics on desktop and list items on
mobile. Avoid horizontal nested cards.

- [ ] **Step 6: Make profile selection use result-set identity**

Store the selected result-set ID, not only the latest leaderboard row ID.
`ModelEvidenceProfile` receives the exact snapshot row and filters every detail
through `resultSetId`. Closing returns focus to the corresponding latest or
historical trigger.

- [ ] **Step 7: Replace Results copy and audit controls**

Results copy states:

```text
Only fully completed benchmark snapshots appear here. Expand a row to compare
older runs of the same configuration.
```

If no snapshot qualifies but raw evidence exists:

```text
Benchmark evidence is stored, but no fully completed snapshot qualifies for
Results. Open Data to inspect incomplete runs.
```

The certified audit section no longer claims excluded attempts remain in
leaderboard math or exposes attempt-level deletion.

- [ ] **Step 8: Add Data result-set audit**

Render status, subject/configuration, promised tracks, created/terminal time,
physical provider calls, tokens, and sanitized failure. Use explicit labels:
`Published`, `Running`, `Provider failed`, `Cancelled`, `Interrupted`,
`Deleting`, and `Legacy evidence`.

Failed/incomplete rows can delete their entire result set. Legacy evidence is
removable through clear-all/raw maintenance only because it has no trustworthy
snapshot boundary.

- [ ] **Step 9: Pass focused UI and deletion tests**

Run:

```powershell
npx tsx scripts/test-benchmark-result-history-ui.tsx
npx tsx scripts/test-benchmark-result-set-audit-ui.tsx
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npx tsx scripts/test-certified-result-ui-viewmodel.mts
npx tsx scripts/test-benchmark-delete-results.mts
npm run test:benchmark:unit
```

Expected: PASS.

- [ ] **Step 10: Render and critique at desktop/mobile widths**

Start the dev server after ensuring no build is running. Inspect desktop and
mobile screenshots. Check:

- history rail alignment;
- long model/team names;
- dense metrics without clipping;
- focus rings;
- positive/negative delta legibility;
- five-item pagination;
- profile expansion width;
- reduced-motion behavior; and
- no generic nested-card clutter.

Remove any decorative element that does not communicate chronology or state.

- [ ] **Step 11: Self-review and commit**

Search Results components for `attemptId` deletion callbacks and confirm none
remain. Verify every visible historical metric/profile/delete action carries
one result-set ID.

```powershell
git diff --check
git add components/benchmark/results/ResultHistoryRows.tsx components/benchmark/BenchmarkResultSetAudit.tsx components/benchmark/useBenchmarkResultSetDeletion.ts components/BenchmarkPage.tsx components/BenchmarkLab.tsx components/benchmark/results/BenchmarkDecisionDashboard.tsx components/benchmark/results/DecisionLeaderboard.tsx components/benchmark/results/ModelEvidenceProfile.tsx components/benchmark/certified/CertifiedBenchmarkOverview.tsx components/benchmark/certified/CertifiedResultTables.tsx components/benchmark/results/LensTabs.tsx components/benchmark/useBenchmarkDashboard.ts components/benchmark/BenchmarkReportSummary.tsx scripts/test-benchmark-result-history-ui.tsx scripts/test-benchmark-result-set-audit-ui.tsx scripts/test-benchmark-decision-dashboard-ui.mts scripts/test-certified-result-ui-viewmodel.mts scripts/test-benchmark-delete-results.mts package.json
git commit -m "feat(benchmark): show expandable result history"
```

---

## Whole-Branch Acceptance and Local Integration

These are orchestrator acceptance gates after all task commits and task reviews;
they are not substitutes for each task's focused tests.

- [ ] Run final independent `final_reviewer` and `spec_reviewer` reviews in
  parallel.
- [ ] Route every important finding through one focused fix wave and a
  fix-only `re_reviewer`.
- [ ] Stop the development server.
- [ ] Run:

```powershell
npm run test:benchmark
npm run test:runner-v2
npm run typecheck:runner-v2
npx tsc --noEmit --pretty false
npm run lint
npm run build
npx tsx scripts/test-deploy-runner-artifacts.mts
git diff --check
git status --short
```

- [ ] Restart the local account-provider runner from the verified version-19
  artifact and confirm `/health` without printing its token.
- [ ] Restart the app development server.
- [ ] Use the Chrome-control skill and real Chrome.
- [ ] Enter the supplied URL/token only through Settings.
- [ ] Select GPT-5.6 Luna, GPT-5.6 Terra, and GPT-5.6 Sol at Medium.
- [ ] Start ModelIQ, leave the benchmark route for part of the run, return, and
  confirm it remained active and cancel still targets the original run.
- [ ] Let every model settle; do not intentionally sabotage a paid request.
- [ ] Verify completed subjects publish independently, no incomplete row
  appears, retry progress is sane if a natural transient error occurs, and
  Chrome console has no errors.
- [ ] Use deterministic local snapshots to verify inline history, deltas,
  five-item `Show more`, historical profiles, and deletion without buying a
  second full ModelIQ run solely for UI history.
- [ ] Verify Data exposes unpublished/audit evidence and physical retry usage.
- [ ] Remove the acceptance credential from UI storage unless the user asks to
  retain it.
- [ ] Use the finishing-development-branch workflow to merge the verified
  feature branch into local `main`.
- [ ] Re-run the focused result-set/retry/UI tests, TypeScript, lint, build, and
  artifact verification on local `main`.
- [ ] Confirm local `main` is clean and report commits, verification, live
  result, any naturally observed provider retry, and any skipped check.
