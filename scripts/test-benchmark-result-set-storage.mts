/* Durable result-set storage checks (run: npx tsx scripts/test-benchmark-result-set-storage.mts). */
import assert from "node:assert/strict";
import {
  __enableBenchmarkRunBlobStorageForTests,
  __clearClientStoreForTests,
  __getBenchmarkRunBlobsForTests,
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
} from "../lib/benchmark/store";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import type { BenchmarkAttemptV2, BenchmarkResultSet, BenchmarkRun } from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
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
  const completed = { ...pending, status: "completed" as const, completedAt: now, terminalAt: now };
  await saveBenchmarkResultSet(completed);
  assert.equal(JSON.parse(__getBenchmarkRunBlobsForTests()[pending.anchorRunId]!).resultSets[0].status, "completed");
  const exported = exportBenchmarkReportBundleV2();
  assert.equal(exported.resultSets?.length, 1);
  await importBenchmarkReportBundleV2({ ...exported, resultSets: undefined });
  assert.equal((await listBenchmarkAttemptsV2())[0]?.resultSetId, "set-1");
  const sibling = { ...resultSet("set-2", "run-a"), status: "completed" as const, completedAt: now, terminalAt: now };
  await saveBenchmarkResultSet(sibling);
  await saveBenchmarkAttemptV2({ ...attempt("attempt-2", "run-a"), resultSetId: sibling.id });
  const deletion = await deleteBenchmarkResultSetCascade(completed.id);
  assert.equal(deletion.resultSets, 1);
  assert.deepEqual((await listBenchmarkResultSets()).map((set) => set.id), ["set-2"]);
  assert.deepEqual((await listBenchmarkAttemptsV2()).map((entry) => entry.id), ["attempt-2"]);
  await saveBenchmarkResultSet({ ...sibling, status: "deleting", terminalAt: now });
  assert.deepEqual(await listBenchmarkResultSets(), []);
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
  await saveBenchmarkResultSet({ ...ordered, status: "completed", completedAt: now, terminalAt: now });
  const completionWrites = writes.slice(writes.findIndex((entry) => entry === "evidence:evidence"));
  assert.equal(completionWrites.at(-1), "anchor:completed");
  __setAdapterForTests(null);
  console.log("PASS");
}
main().catch((error) => { console.error(error); process.exit(1); });
