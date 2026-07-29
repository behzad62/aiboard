import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  listBenchmarkResultSets,
  saveBenchmarkAttemptV2,
  saveBenchmarkCaseV2,
  saveBenchmarkRun,
  saveBenchmarkVerifierResult,
} from "../lib/benchmark/store";
import {
  cancelBenchmarkResultSet,
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
  publishBenchmarkResultSetIfComplete,
  reconcileStaleBenchmarkResultSets,
} from "../lib/benchmark/certified/result-set-publication";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkExpectedResultAttempt,
  BenchmarkResultConfiguration,
  BenchmarkRun,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const configuration: BenchmarkResultConfiguration = {
  subjectKind: "model",
  displayName: "Luna",
  providerId: "test",
  modelId: "luna",
  reasoningEffort: "medium",
  roles: [],
  tracks: [],
};

function expected(
  runId: string,
  track: BenchmarkExpectedResultAttempt["track"],
  caseId: string,
  teamCompositionId = "solo-luna"
): BenchmarkExpectedResultAttempt {
  return {
    runId,
    track,
    suiteId: `suite-${track}`,
    caseId,
    caseVersion: "case-v1",
    scoringVersion: "score-v1",
    teamCompositionId,
  };
}

function run(id: string, track: string): BenchmarkRun {
  return {
    id,
    suiteId: `suite-${track}`,
    name: id,
    domain: "model-call",
    status: "running",
    startedAt: now,
    source: "manual",
    modelIds: ["luna"],
    caseIds: [],
    summaryJson: JSON.stringify({ mode: "certified", track }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
    resultSetIds: [],
  };
}

function benchmarkCase(
  id: string,
  track: BenchmarkCaseV2["track"]
): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: id,
    difficulty: "easy",
    tags: [],
    caseVersion: "case-v1",
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: id },
    environment: {
      type: "browser",
      timeoutSeconds: 30,
      network: "none",
    },
    verifier: {
      scorer: "rule-checker",
    },
    budget: {},
    scoring: { scoringVersion: "score-v1", primary: "verified_quality" },
    contamination: {
      originalTask: true,
      canary: `canary-${id}`,
      referenceSolutionPrivate: true,
    },
  };
}

function verifier(id: string, attemptId: string, resultSetId: string): BenchmarkVerifierResult {
  return {
    id,
    attemptId,
    caseId: attemptId.split(":")[1]!,
    passed: false,
    score: 0,
    durationMs: 1,
    resultJson: "{}",
    assertionResults: [],
    artifactIds: [],
    resultSetId,
  };
}

function attempt(
  id: string,
  item: BenchmarkExpectedResultAttempt,
  resultSetId: string,
  score = 0
): BenchmarkAttemptV2 {
  return {
    id,
    runId: item.runId,
    caseId: item.caseId,
    teamCompositionId: item.teamCompositionId,
    mode: "certified",
    track: item.track,
    harnessProfile: "raw-single-model",
    status: score > 0 ? "passed" : "failed_model",
    startedAt: now,
    completedAt: now,
    verifiedQuality: score / 100,
    jobSuccessScore: score,
    efficiencyScore: score,
    costUsd: null,
    inputTokens: 1,
    outputTokens: 1,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1,
    verifierResultId: `verifier:${id}`,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "h",
    promptSetVersion: "p",
    scoringVersion: item.scoringVersion,
    resultSetId,
  };
}

async function reset(): Promise<void> {
  __clearClientStoreForTests();
  __resetBenchmarkStoreForTests();
}

async function saveEvidence(
  item: BenchmarkExpectedResultAttempt,
  resultSetId: string,
  score = 0
): Promise<void> {
  const id = `attempt:${item.caseId}:${item.track}`;
  await saveBenchmarkCaseV2(benchmarkCase(item.caseId, item.track));
  await saveBenchmarkVerifierResult(verifier(`verifier:${id}`, id, resultSetId));
  await saveBenchmarkAttemptV2(attempt(id, item, resultSetId, score));
}

await reset();
const zeroExpected = expected("run-zero", "gameiq", "zero");
await saveBenchmarkRun(run("run-zero", "gameiq"));
const zeroSet = await createPendingBenchmarkResultSet({
  id: "zero",
  schemaVersion: 1,
  executionId: "execution-zero",
  anchorRunId: "run-zero",
  runIds: ["run-zero"],
  configurationKey: "zero-key",
  configuration,
  expectedAttempts: [zeroExpected],
});
assert.equal(zeroSet.status, "pending");
await saveEvidence(zeroExpected, zeroSet.id, 0);
const publishedZero = await publishBenchmarkResultSetIfComplete(zeroSet.id);
assert.equal(publishedZero.status, "completed");
assert.equal(publishedZero.metrics?.overallScore, 0);

await reset();
const game = expected("run-game", "gameiq", "game");
const tool = expected("run-tool", "toolreliability", "tool");
await saveBenchmarkRun(run("run-game", "gameiq"));
await saveBenchmarkRun(run("run-tool", "toolreliability"));
const modelIq = await createPendingBenchmarkResultSet({
  id: "model-iq",
  schemaVersion: 1,
  executionId: "execution-model-iq",
  anchorRunId: "run-game",
  runIds: ["run-game", "run-tool"],
  configurationKey: "model-iq-key",
  configuration: {
    ...configuration,
    tracks: [
      { track: "gameiq", suiteId: "suite-gameiq", caseManifest: [], maxTokens: null },
      { track: "toolreliability", suiteId: "suite-toolreliability", caseManifest: [], maxTokens: null },
    ],
  },
  expectedAttempts: [game, tool],
});
await saveEvidence(game, modelIq.id, 75);
await assert.rejects(
  publishBenchmarkResultSetIfComplete(modelIq.id),
  /missing expected attempt/i
);
assert.equal((await listBenchmarkResultSets())[0]?.status, "pending");
await saveEvidence(tool, modelIq.id, 50);
assert.equal(
  (await publishBenchmarkResultSetIfComplete(modelIq.id)).status,
  "completed"
);

await reset();
for (const id of ["luna", "terra", "sol"]) {
  await saveBenchmarkRun(run(`run-${id}`, "gameiq"));
  const item = expected(`run-${id}`, "gameiq", `case-${id}`, `solo-${id}`);
  await createPendingBenchmarkResultSet({
    id,
    schemaVersion: 1,
    executionId: "execution-models",
    anchorRunId: item.runId,
    runIds: [item.runId],
    configurationKey: `${id}-key`,
    configuration: { ...configuration, displayName: id, modelId: id },
    expectedAttempts: [item],
  });
  if (id !== "sol") {
    await saveEvidence(item, id, id === "luna" ? 0 : 80);
    await publishBenchmarkResultSetIfComplete(id);
  }
}
await failBenchmarkResultSet("sol", {
  kind: "infrastructure",
  code: "provider_unavailable",
  message: "Sol provider unavailable.",
});
assert.deepEqual(
  (await listBenchmarkResultSets()).map(({ id, status }) => [id, status]),
  [["luna", "completed"], ["terra", "completed"], ["sol", "failed"]]
);
await cancelBenchmarkResultSet("luna", "late cancellation");
assert.equal(
  (await listBenchmarkResultSets()).find((item) => item.id === "luna")?.status,
  "completed"
);

await reset();
await saveBenchmarkRun(run("run-stale", "gameiq"));
await createPendingBenchmarkResultSet({
  id: "stale",
  schemaVersion: 1,
  executionId: "execution-stale",
  anchorRunId: "run-stale",
  runIds: ["run-stale"],
  configurationKey: "stale-key",
  configuration,
  expectedAttempts: [],
});
assert.equal(
  await reconcileStaleBenchmarkResultSets({
    nowMs: Date.parse(now) + 25 * 60 * 60 * 1000,
    hasLiveTabRun: true,
  }),
  0
);
assert.equal(
  await reconcileStaleBenchmarkResultSets({
    nowMs: Date.parse(now) + 25 * 60 * 60 * 1000,
    hasLiveTabRun: false,
  }),
  1
);
assert.equal((await listBenchmarkResultSets())[0]?.status, "failed");

console.log("PASS benchmark result-set publication");
