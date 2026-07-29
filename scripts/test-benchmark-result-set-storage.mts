/* Durable result-set storage checks (run: npx tsx scripts/test-benchmark-result-set-storage.mts). */
import assert from "node:assert/strict";
import {
  __enableBenchmarkRunBlobStorageForTests,
  __clearClientStoreForTests,
  __getBenchmarkRunBlobsForTests,
  __loadClientStoreFromAdapterForTests,
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
import type { StorageAdapter } from "../lib/client/storage-adapter";
import type { BenchmarkAttemptV2, BenchmarkResultSet, BenchmarkRun } from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const metrics = {
  attempts: 1, passed: 1, failed: 0, verifiedPassRate: 1, verifiedQuality: 1,
  overallScore: 100, trackBreakdown: [{
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
): StorageAdapter & { runBlobs: Map<string, string>; failDeleteRunId?: string } {
  const runBlobs = new Map(Object.entries(initialRunBlobs));
  return {
    kind: "filesystem",
    runBlobs,
    async load() { return null; },
    async save() {},
    async listDiscussionIds() { return []; },
    async loadDiscussionFile() { return null; },
    async saveDiscussionFile() {},
    async deleteDiscussionFile() {},
    async deleteDiscussion() {},
    async listBenchmarkRunIds() { return [...runBlobs.keys()]; },
    async loadBenchmarkRun(id) { return runBlobs.get(id) ?? null; },
    async saveBenchmarkRun(id, blob) { runBlobs.set(id, blob); },
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
