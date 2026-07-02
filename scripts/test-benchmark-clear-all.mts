/* Clear-all benchmark data checks (run: npx tsx scripts/test-benchmark-clear-all.mts)
 *
 * Covers clearAllBenchmarkData(): every benchmark array (v1 + v2) empties,
 * adapter run ids empty, a post-clear rescan resurrects nothing, non-benchmark
 * stores (a game match record + a model stat) survive, a double clear is safe,
 * and the returned counts match what was seeded.
 */
import {
  __clearClientStoreForTests,
  __resetClientStoreForTests,
  __enableBenchmarkRunBlobStorageForTests,
  __setBenchmarkRunBlobRawForTests,
  __getBenchmarkRunBlobsForTests,
  clearAllBenchmarkData,
  accumulateModelStats,
  getBenchmarkArtifacts,
  getBenchmarkAttempts,
  getBenchmarkAttemptsV2,
  getBenchmarkCases,
  getBenchmarkCaseV2,
  getBenchmarkFailures,
  getBenchmarkHarnessCertifications,
  getBenchmarkMetricValues,
  getBenchmarkRunEvents,
  getBenchmarkRuns,
  getBenchmarkSuites,
  getBenchmarkTeamCompositions,
  getBenchmarkToolCallTraces,
  getBenchmarkTraces,
  getBenchmarkVerifierResults,
  getCorruptBenchmarkRunCount,
  getGenericGameMatchRecords,
  getModelStats,
  rescanBenchmarkRunFiles,
  saveGenericGameMatchRecord,
  upsertBenchmarkArtifact,
  upsertBenchmarkAttempt,
  upsertBenchmarkAttemptV2,
  upsertBenchmarkCase,
  upsertBenchmarkCaseV2,
  upsertBenchmarkFailure,
  upsertBenchmarkHarnessCertification,
  upsertBenchmarkMetricValue,
  upsertBenchmarkRun,
  upsertBenchmarkRunEvent,
  upsertBenchmarkSuite,
  upsertBenchmarkTeamComposition,
  upsertBenchmarkToolCallTrace,
  upsertBenchmarkTrace,
  upsertBenchmarkVerifierResult,
} from "../lib/client/store";
import type {
  BenchmarkArtifact,
  BenchmarkAttempt,
  BenchmarkAttemptV2,
  BenchmarkCase,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkModelCallTrace,
  BenchmarkReportBundleV2,
  BenchmarkRun,
  BenchmarkRunEvent,
  BenchmarkSuite,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
  HarnessCertificationResult,
} from "../lib/benchmark/types";
import type { GenericGameMatchRecord } from "../lib/games/core/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-07-02T12:00:00.000Z";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const suite: BenchmarkSuite = {
  id: "suite-clear",
  name: "Clear suite",
  createdAt: now,
  updatedAt: now,
  caseIds: ["case-clear"],
  modelIds: ["provider:model"],
  configJson: "{}",
};

function runFixture(id: string): BenchmarkRun {
  return {
    id,
    suiteId: suite.id,
    name: `Run ${id}`,
    domain: "model-call",
    status: "completed",
    startedAt: now,
    completedAt: now,
    source: "manual",
    modelIds: ["provider:model"],
    caseIds: ["case-clear"],
    summaryJson: "{}",
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
  };
}

const benchmarkCase: BenchmarkCase = {
  id: "case-clear",
  kind: "fixed-pack",
  domain: "model-call",
  title: "Clear case",
  createdAt: now,
  updatedAt: now,
  tags: [],
  configJson: "{}",
};

const caseV2: BenchmarkCaseV2 = {
  id: "casev2-clear",
  schemaVersion: 2,
  track: "toolreliability",
  title: "Clear case v2",
  description: "A case",
  difficulty: "easy",
  tags: [],
  caseVersion: "1.0.0",
  createdAt: now,
  updatedAt: now,
  prompt: { userRequest: "do it" },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: { scorer: "verifier-json" },
  budget: {},
  scoring: { scoringVersion: "toolreliability-current", primary: "tool_reliability" },
  contamination: {
    originalTask: true,
    referenceSolutionPrivate: true,
    canary: "canary-clear",
  },
};

function attemptV1Fixture(runId: string): BenchmarkAttempt {
  return {
    id: `attempt-v1-${runId}`,
    runId,
    caseId: "case-clear",
    modelId: "provider:model",
    status: "completed",
    startedAt: now,
    completedAt: now,
    resultJson: "{}",
    traceIds: [],
    artifactIds: [],
    failureIds: [],
  };
}

function attemptV2Fixture(runId: string): BenchmarkAttemptV2 {
  return {
    id: `attempt-v2-${runId}`,
    runId,
    caseId: "casev2-clear",
    teamCompositionId: "team-clear",
    mode: "certified",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: now,
    completedAt: now,
    verifiedQuality: 1,
    jobSuccessScore: 100,
    efficiencyScore: 100,
    toolReliabilityScore: 100,
    costUsd: null,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 100,
    verifierResultId: `verifier-${runId}`,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "toolreliability-harness-current",
    promptSetVersion: "toolreliability-prompts-current",
    scoringVersion: "toolreliability-current",
  };
}

const metricValue: BenchmarkMetricValue = {
  id: "metric-clear",
  runId: "run-a",
  domain: "model-call",
  key: "quality",
  label: "Quality",
  value: 1,
  direction: "higher",
};

const artifact: BenchmarkArtifact = {
  id: "artifact-clear",
  runId: "run-a",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  kind: "json",
  label: "Artifact",
  mimeType: "application/json",
  content: "{}",
  createdAt: now,
};

const failure: BenchmarkFailure = {
  id: "failure-clear",
  runId: "run-a",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  domain: "model-call",
  source: "provider",
  code: "provider_unavailable",
  severity: "error",
  message: "boom",
  createdAt: now,
};

const trace: BenchmarkModelCallTrace = {
  id: "trace-clear",
  runId: "run-a",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  modelId: "provider:model",
  providerId: "provider",
  startedAt: now,
  completedAt: now,
  latencyMs: 100,
  inputTokens: 10,
  outputTokens: 5,
  estimatedUsd: null,
  retryHistory: [],
};

const runEvent: BenchmarkRunEvent = {
  id: "event-clear",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  type: "model_call_completed",
  phase: "model_call_completed",
  at: now,
  message: "done",
};

const toolTrace: BenchmarkToolCallTrace = {
  id: "tool-clear",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  toolName: "toolreliability:tool_validation",
  status: "ok",
  startedAt: now,
  completedAt: now,
  durationMs: 1,
};

const verifier: BenchmarkVerifierResult = {
  id: "verifier-run-a",
  attemptId: "attempt-v2-run-a",
  caseId: "casev2-clear",
  passed: true,
  score: 100,
  durationMs: 1,
  resultJson: "{}",
  assertionResults: [],
  artifactIds: [],
};

const team: BenchmarkTeamComposition = {
  id: "team-clear",
  name: "Solo",
  comboHash: "hash-clear",
  strategy: "solo",
  roles: [
    {
      role: "single",
      slot: "solo",
      modelId: "provider:model",
      providerId: "provider",
      displayName: "Model",
      temperature: 0,
    },
  ],
};

const cert: HarnessCertificationResult = {
  id: "cert-clear",
  createdAt: now,
  aiboardVersion: "test",
  benchmarkEngineVersion: "test",
  harnessProfile: "raw-single-model",
  harnessVersion: "toolreliability-harness-current",
  promptSetVersion: "toolreliability-prompts-current",
  passed: true,
  checks: [{ id: "check", label: "check", passed: true }],
};

/** Minimal run-file bundle (runs + attemptsV2) matching the persisted shape. */
function bundleJson(runId: string): string {
  const bundle: Partial<BenchmarkReportBundleV2> = {
    version: 2,
    suites: [],
    runs: [runFixture(runId)],
    cases: [],
    caseV2: [],
    attempts: [],
    attemptsV2: [attemptV2Fixture(runId)],
    metricValues: [],
    artifacts: [],
    failures: [],
    traces: [],
    runEvents: [],
    toolCallTraces: [],
    verifierResults: [],
    teamCompositions: [],
    harnessCertifications: [],
  };
  return JSON.stringify(bundle);
}

// Non-benchmark records that MUST survive the clear.
const gameMatch: GenericGameMatchRecord = {
  id: "match-keep",
  gameId: "chess",
  timestamp: now,
  participants: [],
  resultJson: "{}",
  statsJson: "{}",
};

// ── Seed ──────────────────────────────────────────────────────────────────────
__resetClientStoreForTests();
__enableBenchmarkRunBlobStorageForTests();

upsertBenchmarkSuite(suite);
upsertBenchmarkRun(runFixture("run-a"));
upsertBenchmarkRun(runFixture("run-b"));
upsertBenchmarkCase(benchmarkCase);
upsertBenchmarkCaseV2(caseV2);
upsertBenchmarkAttempt(attemptV1Fixture("run-a"));
upsertBenchmarkAttemptV2(attemptV2Fixture("run-a"));
upsertBenchmarkAttemptV2(attemptV2Fixture("run-b"));
upsertBenchmarkMetricValue(metricValue);
upsertBenchmarkArtifact(artifact);
upsertBenchmarkFailure(failure);
upsertBenchmarkTrace(trace);
upsertBenchmarkRunEvent(runEvent);
upsertBenchmarkToolCallTrace(toolTrace);
upsertBenchmarkVerifierResult(verifier);
upsertBenchmarkTeamComposition(team);
upsertBenchmarkHarnessCertification(cert);

// Run blob files (simulate persisted per-run evidence for two runs).
__setBenchmarkRunBlobRawForTests("run-a", bundleJson("run-a"));
__setBenchmarkRunBlobRawForTests("run-b", bundleJson("run-b"));

// Non-benchmark stores.
saveGenericGameMatchRecord(gameMatch);
accumulateModelStats({
  judgeModelId: "provider:judge",
  workers: [
    {
      modelId: "provider:worker",
      displayName: "Worker",
      attempts: 1,
      approvals: 1,
      fixes: 0,
      badOutput: 0,
      unavailable: 0,
      wApprovals: 1,
      wFixes: 0,
      wBadOutput: 0,
      responseMs: 100,
      responseChars: 50,
    },
  ],
});

const seededRecords =
  getBenchmarkSuites().length +
  getBenchmarkRuns().length +
  getBenchmarkCases().length +
  getBenchmarkCaseV2().length +
  getBenchmarkAttempts().length +
  getBenchmarkAttemptsV2().length +
  getBenchmarkMetricValues().length +
  getBenchmarkArtifacts().length +
  getBenchmarkFailures().length +
  getBenchmarkTraces().length +
  getBenchmarkRunEvents().length +
  getBenchmarkToolCallTraces().length +
  getBenchmarkVerifierResults().length +
  getBenchmarkTeamCompositions().length +
  getBenchmarkHarnessCertifications().length;

check("seed produced benchmark records", seededRecords > 0, { seededRecords });
check("seed produced two run blob files", Object.keys(__getBenchmarkRunBlobsForTests()).length === 2);
check("seed produced a game match record", getGenericGameMatchRecords().length === 1);
check("seed produced a model stat", getModelStats().length === 1);

// ── Clear ─────────────────────────────────────────────────────────────────────
const result = await clearAllBenchmarkData();

check(
  "clear returns record count matching what was seeded",
  result.records === seededRecords,
  { returned: result.records, seededRecords }
);
check("clear returns run file count of two", result.runFiles === 2, result);

// ── All benchmark arrays empty ────────────────────────────────────────────────
check(
  "every benchmark array is empty after clear",
  getBenchmarkSuites().length === 0 &&
    getBenchmarkRuns().length === 0 &&
    getBenchmarkCases().length === 0 &&
    getBenchmarkCaseV2().length === 0 &&
    getBenchmarkAttempts().length === 0 &&
    getBenchmarkAttemptsV2().length === 0 &&
    getBenchmarkMetricValues().length === 0 &&
    getBenchmarkArtifacts().length === 0 &&
    getBenchmarkFailures().length === 0 &&
    getBenchmarkTraces().length === 0 &&
    getBenchmarkRunEvents().length === 0 &&
    getBenchmarkToolCallTraces().length === 0 &&
    getBenchmarkVerifierResults().length === 0 &&
    getBenchmarkTeamCompositions().length === 0 &&
    getBenchmarkHarnessCertifications().length === 0
);

check(
  "adapter run blob storage is empty after clear",
  Object.keys(__getBenchmarkRunBlobsForTests()).length === 0
);
check("corrupt count is zero after clear", getCorruptBenchmarkRunCount() === 0);

// ── Rescan after clear resurrects nothing ─────────────────────────────────────
const rescan = await rescanBenchmarkRunFiles();
check("rescan after clear merges nothing", rescan.merged === 0, rescan);
check(
  "rescan after clear leaves benchmark arrays empty",
  getBenchmarkRuns().length === 0 && getBenchmarkAttemptsV2().length === 0
);

// ── Non-benchmark stores untouched ────────────────────────────────────────────
check("game match record survives clear", getGenericGameMatchRecords().length === 1);
check(
  "game match record is the seeded one",
  getGenericGameMatchRecords()[0]?.id === "match-keep"
);
check("model stat survives clear", getModelStats().length === 1);
check(
  "model stat is the seeded worker",
  getModelStats().some((stat) => stat.modelId === "provider:worker")
);

// ── Double clear is safe ──────────────────────────────────────────────────────
const second = await clearAllBenchmarkData();
check("double clear returns zero records", second.records === 0, second);
check("double clear returns zero run files", second.runFiles === 0, second);
check("double clear keeps game match record", getGenericGameMatchRecords().length === 1);
check("double clear keeps model stat", getModelStats().length === 1);

__clearClientStoreForTests();

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
