/* Durable result-set storage checks (run: npx tsx scripts/test-benchmark-result-set-storage.mts). */
import assert from "node:assert/strict";
import {
  __enableBenchmarkRunBlobStorageForTests,
  __clearClientStoreForTests,
  __getBenchmarkRunBlobsForTests,
  __loadClientStoreFromAdapterForTests,
  __exportBenchmarkStoreForTests,
  __resetClientStoreForTests,
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
  deleteBenchmarkResultSetCascade,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
  resumeDeletingBenchmarkResultSets,
  saveBenchmarkAttemptV2,
  saveBenchmarkResultSet,
  saveBenchmarkRun,
  setBenchmarkResultSetDeletionResumer,
} from "../lib/benchmark/store";
import { refreshBenchmarkDashboardStorage } from "../components/benchmark/useBenchmarkDashboard";
import { failBenchmarkResultSet } from "../lib/benchmark/certified/result-set-publication";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import type { BenchmarkAttemptV2, BenchmarkResultSet, BenchmarkRun } from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const metrics = {
  attempts: 1, passed: 1, failed: 0, verifiedPassRate: 1, verifiedQuality: 1,
  overallScore: 1, trackBreakdown: [{
    track: "toolreliability" as const, attempts: 1, passed: 1,
    verifiedPassRate: 1, averageVerifiedQuality: 1,
  }],
  jobSuccessScore: 100, efficiencyScore: 100, toolReliabilityScore: 100,
  toolReliabilitySamples: 1, costUsd: null, averageCostUsd: null, durationMs: 1,
  costPerPass: null, speedPerPassMs: 1, inputTokens: 1, outputTokens: 1,
  totalTokens: 2, tokensPerPass: 2, costBasis: "tokens" as const,
};
const run = (id: string): BenchmarkRun => ({
  id, name: id, domain: "model-call", status: "completed", startedAt: now,
  completedAt: now, source: "manual", modelIds: ["provider:model"], caseIds: ["case-1"],
  summaryJson: "{}", metricValueIds: [], artifactIds: [], failureIds: [], resultSetIds: [],
});
const attempt = (id: string, runId: string): BenchmarkAttemptV2 => ({
  id, runId, caseId: "case-1", teamCompositionId: "team-1", mode: "certified",
  track: "toolreliability", harnessProfile: "raw-single-model", status: "passed",
  startedAt: now, completedAt: now, verifiedQuality: 1, jobSuccessScore: 100,
  efficiencyScore: 100, toolReliabilityScore: 100, costUsd: null, inputTokens: 1,
  outputTokens: 1, modelCalls: 1, toolCalls: 0, durationMs: 1, artifactIds: [], traceIds: [],
  failureIds: [], harnessVersion: "h", promptSetVersion: "p", scoringVersion: "s",
});
const resultSet = (id: string, anchorRunId: string, runIds = [anchorRunId]): BenchmarkResultSet => ({
  id, schemaVersion: 1, executionId: `execution-${id}`, anchorRunId, runIds,
  configurationKey: `key-${id}`, configuration: {
    subjectKind: "model", displayName: id, providerId: "provider", modelId: "model",
    roles: [], tracks: [],
  }, expectedAttempts: [], status: "pending", createdAt: now,
});
const completedResultSet = (record: BenchmarkResultSet): BenchmarkResultSet => ({
  ...record, status: "completed", completedAt: now, terminalAt: now, metrics,
});

function emptyBundle() {
  return {
    version: 2 as const, exportedAt: now, suites: [], runs: [], cases: [],
    attempts: [], metricValues: [], artifacts: [], failures: [], traces: [],
    caseV2: [], attemptsV2: [], verifierResults: [], runEvents: [],
    toolCallTraces: [], teamCompositions: [], harnessCertifications: [],
  };
}

function memoryAdapter(
  initialRunBlobs: Record<string, string> = {}
): StorageAdapter & {
  runBlobs: Map<string, string>;
  failDeleteRunId?: string;
  failSaveRunId?: string;
  failSaveOnCall?: number;
  saveCallCount: number;
} {
  const runBlobs = new Map(Object.entries(initialRunBlobs));
  return {
    kind: "filesystem",
    runBlobs,
    saveCallCount: 0,
    async load() { return null; },
    async save() {},
    async listDiscussionIds() { return []; },
    async loadDiscussionFile() { return null; },
    async saveDiscussionFile() {},
    async deleteDiscussionFile() {},
    async deleteDiscussion() {},
    async listBenchmarkRunIds() { return [...runBlobs.keys()]; },
    async loadBenchmarkRun(id) { return runBlobs.get(id) ?? null; },
    async saveBenchmarkRun(id, blob) {
      this.saveCallCount += 1;
      if (this.failSaveOnCall === this.saveCallCount) {
        this.failSaveOnCall = undefined;
        throw new Error("injected later benchmark write failure");
      }
      if (this.failSaveRunId === id) {
        this.failSaveRunId = undefined;
        throw new Error("injected benchmark write failure");
      }
      runBlobs.set(id, blob);
    },
    async deleteBenchmarkRun(id) {
      if (this.failDeleteRunId === id) {
        this.failDeleteRunId = undefined;
        throw new Error("injected deletion failure");
      }
      runBlobs.delete(id);
    },
    label() { return "result-set-memory"; },
  };
}

function benchmarkState(): Omit<
  ReturnType<typeof exportBenchmarkReportBundleV2>,
  "exportedAt" | "bundleHash"
> {
  const { exportedAt: _exportedAt, bundleHash: _bundleHash, ...state } =
    exportBenchmarkReportBundleV2();
  return state;
}

async function main(): Promise<void> {
  __clearClientStoreForTests();
  __clearClientStoreForTests();
  __resetBenchmarkStoreForTests();
  __enableBenchmarkRunBlobStorageForTests();
  await saveBenchmarkRun(run("run-a"));
  await saveBenchmarkRun(run("run-b"));
  const pending = resultSet("set-1", "run-a", ["run-a", "run-b"]);
  await saveBenchmarkResultSet(pending);
  assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.id), ["set-1"]);
  assert.equal(JSON.parse(__getBenchmarkRunBlobsForTests()[pending.anchorRunId]!).resultSets[0].status, "pending");
  await saveBenchmarkAttemptV2({ ...attempt("attempt-1", "run-b"), resultSetId: pending.id });
  const completed = completedResultSet(pending);
  await saveBenchmarkResultSet(completed);
  assert.equal(JSON.parse(__getBenchmarkRunBlobsForTests()[pending.anchorRunId]!).resultSets[0].status, "completed");
  const exported = exportBenchmarkReportBundleV2();
  assert.equal(exported.resultSets?.length, 1);
  await importBenchmarkReportBundleV2({ ...exported, resultSets: undefined });
  assert.equal((await listBenchmarkAttemptsV2())[0]?.resultSetId, "set-1");
  const sibling = completedResultSet(resultSet("set-2", "run-a"));
  await saveBenchmarkResultSet(sibling);
  await saveBenchmarkAttemptV2({ ...attempt("attempt-2", "run-a"), resultSetId: sibling.id });
  const deletion = await deleteBenchmarkResultSetCascade(completed.id);
  assert.equal(deletion.resultSets, 1);
  assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.id), ["set-2"]);
  assert.deepEqual((await listBenchmarkAttemptsV2()).map((entry) => entry.id), ["attempt-2"]);
  await saveBenchmarkResultSet({ ...sibling, status: "deleting", terminalAt: now });
  assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.status), ["deleting"]);
  assert.equal(exportBenchmarkReportBundleV2().resultSets?.[0]?.status, "deleting");
  assert.equal(await resumeDeletingBenchmarkResultSets(), 1);
  assert.deepEqual(await listBenchmarkResultSets(), []);

  // The completed anchor is the publication marker: referenced evidence writes first.
  __clearClientStoreForTests();
  __resetBenchmarkStoreForTests();
  const writes: string[] = [];
  const adapter: StorageAdapter = {
    kind: "filesystem", async load() { return null; }, async save() {},
    async listDiscussionIds() { return []; }, async loadDiscussionFile() { return null; },
    async saveDiscussionFile() {}, async deleteDiscussionFile() {}, async deleteDiscussion() {},
    async listBenchmarkRunIds() { return []; }, async loadBenchmarkRun() { return null; },
    async saveBenchmarkRun(id, blob) { writes.push(`${id}:${JSON.parse(blob).resultSets?.[0]?.status ?? "evidence"}`); },
    async deleteBenchmarkRun() {}, label() { return "result-set-order"; },
  };
  __setAdapterForTests(adapter);
  await saveBenchmarkRun(run("anchor")); await saveBenchmarkRun(run("evidence"));
  const ordered = resultSet("ordered", "anchor", ["anchor", "evidence"]);
  await saveBenchmarkResultSet(ordered);
  await saveBenchmarkAttemptV2({ ...attempt("ordered-attempt", "evidence"), resultSetId: ordered.id });
  const beforeCompletion = writes.length;
  await saveBenchmarkResultSet(completedResultSet(ordered));
  const completionWrites = writes.slice(beforeCompletion);
  assert.deepEqual(completionWrites, ["evidence:evidence", "anchor:completed"]);
  assert.equal(completionWrites.at(-1), "anchor:completed");
  __setAdapterForTests(null);

  // Failed completion-anchor persistence restores the exact prior visible state.
  __clearClientStoreForTests();
  __resetClientStoreForTests({ benchmarkRuns: [run("rollback-anchor")] });
  const rollbackAdapter = memoryAdapter();
  __setAdapterForTests(rollbackAdapter);
  const rollbackPending = resultSet("rollback-set", "rollback-anchor");
  await saveBenchmarkResultSet(rollbackPending);
  rollbackAdapter.failSaveRunId = "rollback-anchor";
  await assert.rejects(
    saveBenchmarkResultSet(completedResultSet(rollbackPending)),
    /injected benchmark write failure/
  );
  assert.equal((await listBenchmarkResultSets())[0]?.status, "pending");
  __clearClientStoreForTests();
  await __loadClientStoreFromAdapterForTests(rollbackAdapter);
  assert.equal((await listBenchmarkResultSets())[0]?.status, "pending");
  await assert.rejects(
    deleteBenchmarkResultSetCascade(rollbackPending.id),
    /pending|active|running/i
  );
  await saveBenchmarkResultSet(completedResultSet(rollbackPending));
  assert.equal((await listBenchmarkResultSets())[0]?.status, "completed");

  // A failed import write likewise leaves neither candidate manifests nor
  // candidate child evidence visible in memory or after reload.
  rollbackAdapter.failSaveRunId = "import-failure-run";
  await assert.rejects(
    importBenchmarkReportBundleV2({
      ...emptyBundle(),
      runs: [run("import-failure-run")],
      resultSets: [resultSet("import-failure-set", "import-failure-run")],
    }),
    /injected benchmark write failure/
  );
  assert.ok(
    !(await listBenchmarkResultSets()).some((set) => set.id === "import-failure-set")
  );
  __clearClientStoreForTests();
  await __loadClientStoreFromAdapterForTests(rollbackAdapter);
  assert.ok(
    !(await listBenchmarkResultSets()).some((set) => set.id === "import-failure-set")
  );
  __setAdapterForTests(null);

  // A later multi-run import write failure restores every earlier durable
  // overwrite/deletion, so a fresh reload is byte-for-byte the pre-import
  // benchmark state rather than a partially imported graph.
  __resetClientStoreForTests({ benchmarkRuns: [run("import-existing-run")] });
  const laterWriteAdapter = memoryAdapter();
  __setAdapterForTests(laterWriteAdapter);
  await saveBenchmarkRun(run("import-existing-run"));
  const beforeLaterWriteMemory = structuredClone(__exportBenchmarkStoreForTests());
  const beforeLaterWriteState = benchmarkState();
  const beforeLaterWriteBlobs = new Map(laterWriteAdapter.runBlobs);
  laterWriteAdapter.failSaveOnCall = laterWriteAdapter.saveCallCount + 2;
  await assert.rejects(
    importBenchmarkReportBundleV2({
      ...emptyBundle(),
      runs: [
        {
          ...run("import-existing-run"),
          name: "mutated by rejected import",
          completedAt: "2026-07-29T11:00:00.000Z",
        },
        run("import-new-run"),
      ],
    }),
    /injected later benchmark write failure/
  );
  assert.deepEqual(__exportBenchmarkStoreForTests(), beforeLaterWriteMemory);
  assert.deepEqual(laterWriteAdapter.runBlobs, beforeLaterWriteBlobs);
  __clearClientStoreForTests();
  await __loadClientStoreFromAdapterForTests(laterWriteAdapter);
  assert.deepEqual(benchmarkState(), beforeLaterWriteState);
  assert.deepEqual(laterWriteAdapter.runBlobs, beforeLaterWriteBlobs);
  __setAdapterForTests(null);

  // Terminal records and tombstones cannot be resurrected by direct saves.
  for (const terminal of [
    { ...resultSet("failed", "failed-run"), status: "failed" as const, terminalAt: now,
      failure: { kind: "runner", code: "failed", message: "failed" } },
    { ...resultSet("cancelled", "cancelled-run"), status: "cancelled" as const, terminalAt: now },
  ]) {
    __resetClientStoreForTests({ benchmarkRuns: [run(terminal.anchorRunId)] });
    await saveBenchmarkResultSet(terminal);
    await assert.rejects(
      saveBenchmarkResultSet({ ...terminal, status: "pending", terminalAt: undefined, failure: undefined }),
      /terminal|immutable/i
    );
  }
  __resetClientStoreForTests({ benchmarkRuns: [run("deleting-run")] });
  const deleting = { ...resultSet("deleting", "deleting-run"), status: "deleting" as const, terminalAt: now };
  await saveBenchmarkResultSet(deleting);
  await assert.rejects(
    saveBenchmarkResultSet({ ...deleting, status: "pending", terminalAt: undefined }),
    /terminal|immutable|deleting/i
  );

  // Imports reject malformed manifests and preserve immutable collisions.
  __resetClientStoreForTests({ benchmarkRuns: [run("collision-run")] });
  const immutableFailed = {
    ...resultSet("collision", "collision-run"), status: "failed" as const, terminalAt: now,
    failure: { kind: "runner", code: "failed", message: "original" },
  };
  await saveBenchmarkResultSet(immutableFailed);
  const collisionImport = await importBenchmarkReportBundleV2({
    ...emptyBundle(), runs: [run("collision-run")],
    resultSets: [completedResultSet({ ...resultSet("collision", "collision-run"), executionId: "replacement" })],
  });
  assert.equal((await listBenchmarkResultSets())[0]?.status, "failed");
  assert.equal((await listBenchmarkResultSets())[0]?.executionId, immutableFailed.executionId);
  assert.equal(collisionImport.updatedByCategory.resultSets ?? 0, 0);
  assert.equal(collisionImport.resultSetCount, 0);
  assert.equal(collisionImport.completedResultSetCount, 0);

  const graphSet = completedResultSet(resultSet("graph", "graph-run"));
  const graphRun = { ...run("graph-run"), resultSetIds: [graphSet.id] };
  const graphAttempt = {
    ...attempt("graph-attempt", graphRun.id),
    resultSetId: graphSet.id,
  };
  const graphArtifact = {
    id: "graph-artifact", runId: graphRun.id, attemptId: graphAttempt.id,
    kind: "patch" as const, label: "original", mimeType: "text/plain",
    content: "original", createdAt: now, resultSetId: graphSet.id,
  };
  const graphFailure = {
    id: "graph-failure", runId: graphRun.id, attemptId: graphAttempt.id,
    domain: "model-call" as const, source: "provider" as const, code: "original",
    severity: "error" as const, message: "original", createdAt: now,
    resultSetId: graphSet.id,
  };
  const graphTrace = {
    id: "graph-trace", runId: graphRun.id, attemptId: graphAttempt.id,
    modelId: "provider:model", providerId: "provider", startedAt: now,
    completedAt: now, retryHistory: [], resultSetId: graphSet.id,
  };
  const graphEvent = {
    id: "graph-event", attemptId: graphAttempt.id, caseId: "case-1",
    type: "run_failed" as const, phase: "original", at: now, message: "original",
    resultSetId: graphSet.id,
  };
  const graphToolTrace = {
    id: "graph-tool", attemptId: graphAttempt.id, caseId: "case-1",
    toolName: "tool", status: "ok" as const, startedAt: now, completedAt: now,
    resultSetId: graphSet.id,
  };
  const later = "2026-07-29T11:00:00.000Z";
  const immutableGraphCases = [
    {
      label: "run",
      current: { benchmarkRuns: [graphRun] },
      incoming: { runs: [{ ...graphRun, name: "mutated", completedAt: later }] },
    },
    {
      label: "attempt",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt] },
      incoming: {
        runs: [graphRun],
        attemptsV2: [{ ...graphAttempt, completedAt: later, verifiedQuality: 0 }],
      },
    },
    {
      label: "artifact",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt], benchmarkArtifacts: [graphArtifact] },
      incoming: { runs: [graphRun], artifacts: [{ ...graphArtifact, label: "mutated", createdAt: later }] },
    },
    {
      label: "failure",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt], benchmarkFailures: [graphFailure] },
      incoming: { runs: [graphRun], failures: [{ ...graphFailure, message: "mutated", createdAt: later }] },
    },
    {
      label: "model trace",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt], benchmarkTraces: [graphTrace] },
      incoming: { runs: [graphRun], traces: [{ ...graphTrace, completedAt: later, error: "mutated" }] },
    },
    {
      label: "run event",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt], benchmarkRunEvents: [graphEvent] },
      incoming: { runs: [graphRun], runEvents: [{ ...graphEvent, at: later, message: "mutated" }] },
    },
    {
      label: "tool trace",
      current: { benchmarkRuns: [graphRun], benchmarkAttemptsV2: [graphAttempt], benchmarkToolCallTraces: [graphToolTrace] },
      incoming: { runs: [graphRun], toolCallTraces: [{ ...graphToolTrace, completedAt: later, error: "mutated" }] },
    },
  ];
  for (const testCase of immutableGraphCases) {
    __resetClientStoreForTests({
      benchmarkResultSets: [graphSet],
      ...testCase.current,
    });
    await assert.rejects(
      importBenchmarkReportBundleV2({
        ...emptyBundle(),
        ...testCase.incoming,
      } as never),
      /immutable terminal benchmark evidence/i,
      testCase.label
    );
  }

  const malformed = [
    { ...resultSet("bad-anchor", "missing"), runIds: ["other"] },
    { ...resultSet("bad-time", "run-x"), createdAt: "not-a-time" },
    { ...resultSet("bad-config", "run-x"), configuration: { subjectKind: "model" } },
    { ...resultSet("bad-expected", "run-x"), expectedAttempts: [{}] },
    { ...completedResultSet(resultSet("bad-terminal", "run-x")), metrics: undefined },
  ];
  for (const record of malformed) {
    await assert.rejects(
      importBenchmarkReportBundleV2({
        ...emptyBundle(), runs: [run("run-x")],
        resultSets: [record as BenchmarkResultSet],
      }),
      /resultSets|result set/i
    );
  }
  await assert.rejects(
    importBenchmarkReportBundleV2({
      ...emptyBundle(),
      resultSets: [resultSet("missing-run-reference", "absent-run")],
    }),
    /resultSets|result set|run/i
  );
  const expectedAttempt = {
    runId: "owned-run", track: "toolreliability" as const, suiteId: "suite-1",
    caseId: "case-1", caseVersion: "v1", scoringVersion: "s",
    teamCompositionId: "team-1",
  };
  const ownedConfiguration = {
    ...resultSet("owned-template", "owned-run").configuration,
    tracks: [{
      track: "toolreliability" as const, suiteId: "suite-1", maxTokens: null,
      caseManifest: [{
        caseId: "case-1", caseVersion: "v1", scoringVersion: "s",
      }],
    }],
  };
  await assert.rejects(
    importBenchmarkReportBundleV2({
      ...emptyBundle(),
      runs: [run("owned-run")],
      resultSets: [completedResultSet({
        ...resultSet("missing-owned-attempt", "owned-run"),
        configuration: ownedConfiguration,
        expectedAttempts: [expectedAttempt],
      })],
    }),
    /resultSets|result set|ownership|attempt/i
  );
  __resetBenchmarkStoreForTests();
  await importBenchmarkReportBundleV2({
    ...emptyBundle(),
    runs: [run("owned-run")],
    attemptsV2: [{
      ...attempt("owned-attempt", "owned-run"),
      resultSetId: "owned-completed",
    }],
    resultSets: [completedResultSet({
      ...resultSet("owned-completed", "owned-run"),
      configuration: ownedConfiguration,
      expectedAttempts: [expectedAttempt],
    })],
  });
  assert.equal((await listBenchmarkResultSets())[0]?.status, "completed");

  // Legacy evidence imports into an empty store without inventing a manifest.
  __resetBenchmarkStoreForTests();
  await importBenchmarkReportBundleV2({
    ...emptyBundle(), runs: [run("legacy-run")],
    attemptsV2: [attempt("legacy-attempt", "legacy-run")],
  });
  assert.deepEqual((await listBenchmarkAttemptsV2()).map((item) => item.id), ["legacy-attempt"]);
  assert.deepEqual(await listBenchmarkResultSets(), []);

  // Import repairs denormalized run ownership from manifests.
  __resetBenchmarkStoreForTests();
  __enableBenchmarkRunBlobStorageForTests();
  const importedSet = resultSet("imported-set", "shared-run");
  await importBenchmarkReportBundleV2({
    ...emptyBundle(), runs: [{ ...run("shared-run"), resultSetIds: [] }],
    resultSets: [importedSet],
  });
  assert.deepEqual(
    JSON.parse(__getBenchmarkRunBlobsForTests()["shared-run"] ?? "{}").runs?.[0]?.resultSetIds,
    ["imported-set"]
  );
  __resetBenchmarkStoreForTests();
  __enableBenchmarkRunBlobStorageForTests();
  await importBenchmarkReportBundleV2({
    ...emptyBundle(), runs: [{ ...run("legacy-links"), resultSetIds: ["ghost"] }],
  });
  assert.deepEqual(
    JSON.parse(__getBenchmarkRunBlobsForTests()["legacy-links"]!).runs[0].resultSetIds,
    []
  );
  __resetClientStoreForTests({ benchmarkRuns: [run("existing-anchor")] });
  __enableBenchmarkRunBlobStorageForTests();
  await importBenchmarkReportBundleV2({
    ...emptyBundle(),
    resultSets: [resultSet("existing-anchor-set", "existing-anchor")],
  });
  assert.equal(
    JSON.parse(__getBenchmarkRunBlobsForTests()["existing-anchor"] ?? "{}")
      .resultSets?.[0]?.id,
    "existing-anchor-set"
  );

  // A shared run remains while any sibling manifest references it, even if the
  // denormalized run link is missing.
  __resetClientStoreForTests({ benchmarkRuns: [run("shared-delete")] });
  __enableBenchmarkRunBlobStorageForTests();
  const first = completedResultSet(resultSet("first", "shared-delete"));
  const second = completedResultSet(resultSet("second", "shared-delete"));
  await saveBenchmarkResultSet(first);
  await saveBenchmarkResultSet(second);
  assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.id), ["first", "second"]);
  const sharedRunRecord = JSON.parse(__getBenchmarkRunBlobsForTests()["shared-delete"]!).runs[0];
  __resetClientStoreForTests({
    benchmarkRuns: [{ ...sharedRunRecord, resultSetIds: ["first"] }],
    benchmarkResultSets: [first, second],
  });
  __enableBenchmarkRunBlobStorageForTests();
  await deleteBenchmarkResultSetCascade("first");
  assert.equal((await listBenchmarkResultSets())[0]?.id, "second");
  const sharedAfterDelete = JSON.parse(__getBenchmarkRunBlobsForTests()["shared-delete"]!);
  assert.equal(
    sharedAfterDelete.runs?.[0]?.id,
    "shared-delete",
    JSON.stringify(sharedAfterDelete)
  );

  // Failure after the durable tombstone is recoverable from real persisted
  // state after resetting all in-memory store state.
  __clearClientStoreForTests();
  __resetClientStoreForTests({ benchmarkRuns: [run("interrupted-run")] });
  const durable = memoryAdapter();
  __setAdapterForTests(durable);
  const interrupted = completedResultSet(resultSet("interrupted", "interrupted-run"));
  await saveBenchmarkResultSet(interrupted);
  durable.failDeleteRunId = "interrupted-run";
  await assert.rejects(deleteBenchmarkResultSetCascade(interrupted.id), /injected deletion failure/);
  assert.equal(
    JSON.parse(durable.runBlobs.get("interrupted-run")!).resultSets[0].status,
    "deleting"
  );
  __clearClientStoreForTests();
  await __loadClientStoreFromAdapterForTests(durable);
  assert.deepEqual(await listBenchmarkResultSets(), []);
  assert.equal(durable.runBlobs.has("interrupted-run"), false);

  // Registering recovery after store readiness runs it immediately and awaits
  // completion rather than leaving startup observably half-recovered.
  __resetBenchmarkStoreForTests();
  let lateRecoveryFinished = false;
  await setBenchmarkResultSetDeletionResumer(async () => {
    await Promise.resolve();
    lateRecoveryFinished = true;
  });
  assert.equal(lateRecoveryFinished, true);
  await setBenchmarkResultSetDeletionResumer(() => resumeDeletingBenchmarkResultSets());

  __resetBenchmarkStoreForTests();
  const secretResultSet = resultSet("secret-failure", "secret-run");
  await saveBenchmarkResultSet(secretResultSet);
  const resultSetSecret = "sk-proj-result-set-secret-1234567890";
  await failBenchmarkResultSet(secretResultSet.id, {
    kind: "provider",
    code: "provider_unavailable",
    message:
      `Authorization: Bearer ${resultSetSecret}; api key ${resultSetSecret}; C:\\Users\\Alice\\private\\result.json`,
  });
  const storedSecretFailure = (await listBenchmarkResultSets()).find(
    (set) => set.id === secretResultSet.id
  )?.failure?.message;
  assert.ok(storedSecretFailure);
  assert.equal(storedSecretFailure.includes(resultSetSecret), false);
  assert.equal(storedSecretFailure.includes("Alice"), false);

  // Dashboard refresh behaviorally rescans and completes a newly discovered
  // tombstone before returning data to callers.
  __clearClientStoreForTests();
  __resetBenchmarkStoreForTests();
  const refreshSet = {
    ...resultSet("refresh-delete", "refresh-run"),
    status: "deleting" as const,
    terminalAt: now,
  };
  const refreshAdapter = memoryAdapter({
    "refresh-run": JSON.stringify({
      ...emptyBundle(),
      runs: [run("refresh-run")],
      resultSets: [refreshSet],
    }),
  });
  __setAdapterForTests(refreshAdapter);
  assert.equal(await refreshBenchmarkDashboardStorage(), true);
  assert.equal(refreshAdapter.runBlobs.has("refresh-run"), false);
  assert.deepEqual(await listBenchmarkResultSets(), []);

  console.log("PASS");
}
main().catch((error) => { console.error(error); process.exit(1); });
