/* Retired GameIQ / Fireworks evidence stays out of dashboards and can be deleted
   (run: npx tsx scripts/test-benchmark-retired-evidence.mts) */
import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  deleteRetiredBenchmarkEvidence,
  findRetiredBenchmarkEvidence,
  listBenchmarkAttemptsV2,
  listBenchmarkRuns,
  saveBenchmarkAttemptV2,
  saveBenchmarkCaseV2,
  saveBenchmarkRun,
} from "../lib/benchmark/store";
import {
  isRetiredBenchmarkResultSet,
  withoutRetiredBenchmarkEvidence,
} from "../lib/benchmark/retired";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkResultSet,
  BenchmarkRun,
} from "../lib/benchmark/types";
import type { CertifiedBenchmarkDashboardInput } from "../lib/benchmark/scoring/types";

const now = "2026-10-15T10:00:00.000Z";

function run(id: string, track: string, suiteId: string): BenchmarkRun {
  return {
    id,
    suiteId,
    name: id,
    domain: "model-call",
    status: "completed",
    startedAt: now,
    completedAt: now,
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

function benchmarkCase(id: string, track: BenchmarkCaseV2["track"]): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: id,
    difficulty: "easy",
    tags: [],
    caseVersion: "v1",
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: id },
    environment: { type: "browser", timeoutSeconds: 30, network: "none" },
    verifier: { scorer: "rule-checker" },
    budget: {},
    scoring: { scoringVersion: "s1", primary: "verified_quality" },
    contamination: { originalTask: true, canary: `c-${id}`, referenceSolutionPrivate: true },
  };
}

function attempt(
  id: string,
  runId: string,
  caseId: string,
  track: BenchmarkAttemptV2["track"],
  resultSetId?: string
): BenchmarkAttemptV2 {
  return {
    id,
    runId,
    caseId,
    teamCompositionId: "solo-luna",
    mode: "certified",
    track,
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: now,
    completedAt: now,
    verifiedQuality: 1,
    jobSuccessScore: 100,
    efficiencyScore: 100,
    costUsd: null,
    inputTokens: 1,
    outputTokens: 1,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "h",
    promptSetVersion: "p",
    scoringVersion: "s1",
    ...(resultSetId ? { resultSetId } : {}),
  };
}

function resultSet(id: string, runIds: string[], tracks: Array<[string, string]>): BenchmarkResultSet {
  return {
    id,
    schemaVersion: 1,
    executionId: `exec-${id}`,
    anchorRunId: runIds[0]!,
    runIds,
    configurationKey: `key-${id}`,
    configuration: {
      subjectKind: "model",
      displayName: "Luna",
      roles: [],
      tracks: tracks.map(([track, suiteId]) => ({
        track: track as BenchmarkCaseV2["track"],
        suiteId,
        caseManifest: [],
        maxTokens: null,
      })),
    },
    expectedAttempts: [],
    status: "completed",
    createdAt: now,
    completedAt: now,
  };
}

// --- Pure filter -----------------------------------------------------------
const gameRun = run("run-game", "gameiq", "gameiq-all-packs");
const fireworksRun = run("run-fw", "teamiq", "fireworks-teamiq-full-v0.1");
const toolRun = run("run-tool", "toolreliability", "toolbench-native-core-v3");
const blended = resultSet("blended", ["run-game", "run-tool"], [
  ["gameiq", "gameiq-all-packs"],
  ["toolreliability", "toolbench-native-core-v3"],
]);
const clean = resultSet("clean", ["run-tool"], [["toolreliability", "toolbench-native-core-v3"]]);
assert.equal(isRetiredBenchmarkResultSet(blended), true);
assert.equal(isRetiredBenchmarkResultSet(clean), false);

const input: CertifiedBenchmarkDashboardInput = {
  resultSets: [blended, clean],
  runs: [gameRun, fireworksRun, toolRun],
  caseV2: [
    benchmarkCase("gameiq-v0.2-chess", "gameiq"),
    benchmarkCase("fireworks-teamiq-full-v0.1", "teamiq"),
    benchmarkCase("toolbench-native-core-v3", "toolreliability"),
  ],
  attemptsV2: [
    attempt("a-game", "run-game", "gameiq-v0.2-chess", "gameiq", "blended"),
    attempt("a-fw", "run-fw", "fireworks-teamiq-full-v0.1", "teamiq"),
    attempt("a-tool", "run-tool", "toolbench-native-core-v3", "toolreliability", "clean"),
  ],
  verifierResults: [],
  artifacts: [],
  failures: [],
  traces: [],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [],
  harnessCertifications: [],
};
const filtered = withoutRetiredBenchmarkEvidence(input);
assert.deepEqual(filtered.resultSets.map((set) => set.id), ["clean"]);
assert.deepEqual(filtered.runs.map((item) => item.id), ["run-tool"]);
assert.deepEqual(filtered.attemptsV2.map((item) => item.id), ["a-tool"]);
assert.deepEqual(filtered.caseV2.map((item) => item.id), ["toolbench-native-core-v3"]);
console.log("PASS retired tracks, suites, and blended result sets are filtered");

const untouched = { ...input, resultSets: [clean], runs: [toolRun], attemptsV2: [input.attemptsV2[2]!] };
assert.strictEqual(withoutRetiredBenchmarkEvidence(untouched), untouched);
console.log("PASS input without retired evidence is returned as-is");

// --- Store deletion --------------------------------------------------------
__clearClientStoreForTests();
__resetBenchmarkStoreForTests();
for (const item of [gameRun, fireworksRun, toolRun]) await saveBenchmarkRun(item);
for (const item of input.caseV2) await saveBenchmarkCaseV2(item);
await saveBenchmarkAttemptV2(input.attemptsV2[1]!);
await saveBenchmarkAttemptV2(input.attemptsV2[2]!);

const found = await findRetiredBenchmarkEvidence();
assert.deepEqual(found.resultSetIds, []);
assert.deepEqual([...found.runIds].sort(), ["run-fw", "run-game"]);
await deleteRetiredBenchmarkEvidence();
assert.deepEqual((await listBenchmarkRuns()).map((item) => item.id), ["run-tool"]);
assert.deepEqual((await listBenchmarkAttemptsV2()).map((item) => item.id), ["a-tool"]);
assert.deepEqual(await findRetiredBenchmarkEvidence(), { resultSetIds: [], runIds: [] });
console.log("PASS retired runs are deleted and live evidence survives");
console.log("PASS");
