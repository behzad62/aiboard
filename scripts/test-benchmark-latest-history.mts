import assert from "node:assert/strict";
import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
import { withCertifiedDeleteMetadata } from "../components/benchmark/useBenchmarkDashboard";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkReportBundleV2,
  BenchmarkResultConfiguration,
  BenchmarkResultSet,
  BenchmarkRun,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

const completedAt = "2026-07-29T10:00:00.000Z";
const benchmarkCase: BenchmarkCaseV2 = {
  id: "history-case",
  schemaVersion: 2,
  track: "gameiq",
  title: "History case",
  description: "One deterministic history case.",
  difficulty: "easy",
  tags: [],
  caseVersion: "case-v1",
  createdAt: completedAt,
  updatedAt: completedAt,
  prompt: { userRequest: "Choose." },
  environment: { type: "browser", timeoutSeconds: 30, network: "none" },
  verifier: { scorer: "rule-checker" },
  budget: {},
  scoring: { scoringVersion: "score-v1", primary: "quality" },
  contamination: {
    originalTask: true,
    canary: "history-canary",
    referenceSolutionPrivate: false,
  },
};

function solo(id: string, modelId: string): BenchmarkTeamComposition {
  return {
    id,
    name: modelId,
    comboHash: id,
    strategy: "solo",
    roles: [{
      role: "single",
      slot: "single",
      providerId: "chatgpt",
      modelId,
      displayName: modelId,
      reasoningEffort: "medium",
      temperature: 0,
    }],
  };
}

const luna = solo("luna-team", "gpt-5.6-luna");
const sol = solo("sol-team", "gpt-5.6-sol");

function configuration(team: BenchmarkTeamComposition): BenchmarkResultConfiguration {
  const role = team.roles[0]!;
  return {
    subjectKind: "model",
    displayName: team.name,
    providerId: role.providerId,
    modelId: role.modelId,
    reasoningEffort: "medium",
    strategy: team.strategy,
    roles: [{
      role: role.role,
      slot: role.slot,
      providerId: role.providerId,
      modelId: role.modelId,
      reasoningEffort: role.reasoningEffort ?? "default",
      maxTokens: role.maxTokens ?? null,
    }],
    tracks: [{
      track: "gameiq",
      suiteId: "history-suite",
      caseManifest: [{
        caseId: benchmarkCase.id,
        caseVersion: benchmarkCase.caseVersion,
        scoringVersion: benchmarkCase.scoring.scoringVersion,
      }],
      maxTokens: null,
    }],
  };
}

function attempt(
  id: string,
  resultSetId: string | undefined,
  runId: string,
  teamCompositionId: string,
  quality: number,
  status: BenchmarkAttemptV2["status"] = "passed"
): BenchmarkAttemptV2 {
  return {
    id,
    runId,
    caseId: benchmarkCase.id,
    teamCompositionId,
    mode: "certified",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    status,
    startedAt: completedAt,
    completedAt,
    verifiedQuality: quality,
    jobSuccessScore: quality * 100,
    efficiencyScore: quality * 100,
    costUsd: null,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 100,
    verifierResultId: status === "passed" ? `verifier-${id}` : undefined,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "harness-v1",
    promptSetVersion: "prompt-v1",
    scoringVersion: benchmarkCase.scoring.scoringVersion,
    resultSetId,
  };
}

function verifier(record: BenchmarkAttemptV2): BenchmarkVerifierResult {
  return {
    id: record.verifierResultId!,
    attemptId: record.id,
    caseId: record.caseId,
    passed: record.status === "passed",
    score: record.verifiedQuality,
    durationMs: 1,
    resultJson: "{}",
    assertionResults: [],
    artifactIds: [],
    resultSetId: record.resultSetId,
  };
}

function runFor(resultSet: BenchmarkResultSet): BenchmarkRun {
  return {
    id: resultSet.anchorRunId,
    suiteId: "history-suite",
    name: resultSet.anchorRunId,
    domain: "build",
    status: "completed",
    startedAt: resultSet.createdAt,
    completedAt: resultSet.completedAt,
    source: "import",
    modelIds: [],
    caseIds: [benchmarkCase.id],
    summaryJson: JSON.stringify({ track: "gameiq" }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
    resultSetIds: [resultSet.id],
  };
}

function resultSet(input: {
  id: string;
  executionId: string;
  runId: string;
  team: BenchmarkTeamComposition;
  completedAt: string;
  overallScore: number;
  passRate: number;
}): BenchmarkResultSet {
  const config = configuration(input.team);
  return {
    id: input.id,
    schemaVersion: 1,
    executionId: input.executionId,
    anchorRunId: input.runId,
    runIds: [input.runId],
    configurationKey: benchmarkResultConfigurationKey(config),
    configuration: config,
    expectedAttempts: [{
      runId: input.runId,
      track: "gameiq",
      suiteId: "history-suite",
      caseId: benchmarkCase.id,
      caseVersion: benchmarkCase.caseVersion,
      scoringVersion: benchmarkCase.scoring.scoringVersion,
      teamCompositionId: input.team.id,
    }],
    status: "completed",
    createdAt: completedAt,
    completedAt: input.completedAt,
    terminalAt: input.completedAt,
    metrics: {
      attempts: 1,
      passed: 1,
      failed: 0,
      verifiedPassRate: input.passRate,
      verifiedQuality: input.overallScore,
      overallScore: input.overallScore,
      trackBreakdown: [{
        track: "gameiq",
        attempts: 1,
        passed: 1,
        verifiedPassRate: input.passRate,
        averageVerifiedQuality: input.overallScore,
      }],
      jobSuccessScore: input.overallScore * 100,
      efficiencyScore: input.overallScore * 100,
      toolReliabilityScore: null,
      toolReliabilitySamples: 0,
      costUsd: null,
      averageCostUsd: null,
      durationMs: 100,
      costPerPass: null,
      speedPerPassMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      tokensPerPass: 15,
      costBasis: "tokens",
    },
  };
}

const oldAttempt = attempt("luna-old-attempt", "luna-old", "run-luna-old", luna.id, 0.65);
const latestAttempt = attempt("luna-new-attempt", "luna-new-complete", "run-luna-new", luna.id, 0.72);
const failedAttempt = attempt(
  "luna-failed-newer-attempt",
  "luna-failed-newer",
  "run-luna-failed",
  luna.id,
  0.99,
  "provider_unavailable"
);
const legacyAttempt = attempt("legacy-attempt", undefined, "run-legacy", luna.id, 1);
const solAttempt = attempt("sol-attempt", "sol-complete", "run-sol", sol.id, 0.8);
const oldSet = resultSet({
  id: "luna-old",
  executionId: "execution-old",
  runId: oldAttempt.runId,
  team: luna,
  completedAt: "2026-07-29T10:00:00.000Z",
  overallScore: 0.65,
  passRate: 0.6,
});
const latestSet = resultSet({
  id: "luna-new-complete",
  executionId: "execution-new",
  runId: latestAttempt.runId,
  team: luna,
  completedAt: "2026-07-29T11:00:00.000Z",
  overallScore: 0.72,
  passRate: 0.8,
});
const failedSet: BenchmarkResultSet = {
  ...resultSet({
    id: "luna-failed-newer",
    executionId: "execution-failed",
    runId: failedAttempt.runId,
    team: luna,
    completedAt: "2026-07-29T12:00:00.000Z",
    overallScore: 0.99,
    passRate: 1,
  }),
  status: "failed",
  metrics: undefined,
};
const solSet = resultSet({
  id: "sol-complete",
  executionId: "execution-sol",
  runId: solAttempt.runId,
  team: sol,
  completedAt: "2026-07-29T11:30:00.000Z",
  overallScore: 0.8,
  passRate: 1,
});
const invalidCompletedSet: BenchmarkResultSet = {
  ...resultSet({
    id: "invalid-completed-marker",
    executionId: "execution-invalid",
    runId: "run-invalid",
    team: luna,
    completedAt: "2026-07-29T13:00:00.000Z",
    overallScore: 1,
    passRate: 1,
  }),
};
const invalidAttempt = {
  ...attempt(
    "invalid-completed-attempt",
    invalidCompletedSet.id,
    invalidCompletedSet.anchorRunId,
    luna.id,
    1
  ),
  artifactIds: ["missing-imported-artifact"],
};
const attempts = [
  oldAttempt,
  latestAttempt,
  failedAttempt,
  legacyAttempt,
  solAttempt,
  invalidAttempt,
];
const verifierResults = [
  oldAttempt,
  latestAttempt,
  solAttempt,
  invalidAttempt,
].map(verifier);
const resultSets = [
  oldSet,
  latestSet,
  failedSet,
  solSet,
  invalidCompletedSet,
];
const runs = resultSets.map(runFor);
const evidence = {
  runs,
  artifacts: [],
  failures: [],
  traces: [],
  runEvents: [],
  toolCallTraces: [],
};

const dashboard = buildCertifiedBenchmarkDashboardData({
  resultSets,
  ...evidence,
  caseV2: [benchmarkCase],
  attemptsV2: attempts,
  verifierResults,
  teamCompositions: [luna, sol],
  harnessCertifications: [],
});
const rowsForLuna = dashboard.leaderboard.filter((row) =>
  row.modelIds.includes("gpt-5.6-luna")
);
assert.equal(rowsForLuna.length, 1, JSON.stringify(dashboard.audit));
assert.equal(rowsForLuna[0]?.resultSetId, "luna-new-complete");
assert.equal(rowsForLuna[0]?.overallDelta, 0.07);
assert.equal(rowsForLuna[0]?.historyCount, 1);
const historyForLuna = dashboard.resultHistory.find(
  (series) => series.latestResultSetId === "luna-new-complete"
)?.older ?? [];
assert.deepEqual(historyForLuna.map((row) => row.resultSetId), ["luna-old"]);
assert.deepEqual(
  new Set(dashboard.leaderboard.map((row) => row.resultSetId)),
  new Set(["luna-new-complete", "sol-complete"])
);
assert.equal(dashboard.audit.completedSnapshots, 3);
assert.equal(dashboard.audit.unpublishedSnapshots, 2);
assert.equal(dashboard.audit.legacyAttempts, 1);

const missingCompositionDashboard = buildCertifiedBenchmarkDashboardData({
  resultSets,
  ...evidence,
  caseV2: [benchmarkCase],
  attemptsV2: attempts,
  verifierResults,
  teamCompositions: [sol],
  harnessCertifications: [],
});
assert.ok(
  !missingCompositionDashboard.leaderboard.some((row) =>
    row.modelIds.includes("gpt-5.6-luna")
  ),
  "a completed marker without its exact composition must remain audit-only"
);

const extraVerifierDashboard = buildCertifiedBenchmarkDashboardData({
  resultSets,
  ...evidence,
  caseV2: [benchmarkCase],
  attemptsV2: attempts,
  verifierResults: [
    ...verifierResults,
    {
      ...verifier(latestAttempt),
      id: "extra-owned-verifier",
      artifactIds: ["missing-extra-verifier-artifact"],
    },
  ],
  teamCompositions: [luna, sol],
  harnessCertifications: [],
});
assert.ok(
  !extraVerifierDashboard.leaderboard.some(
    (row) => row.resultSetId === latestSet.id
  ),
  "every owned verifier reference must exist before publication"
);
const dashboardWithEvidence = withCertifiedDeleteMetadata(
  dashboard,
  attempts,
  [luna, sol]
);
const allDecisionEvidenceIds = new Set([
  ...dashboardWithEvidence.leaderboard.flatMap((row) =>
    row.latestAttemptId ? [row.latestAttemptId] : []
  ),
  ...dashboardWithEvidence.resultHistory.flatMap((series) =>
    series.older.flatMap((row) =>
      row.latestAttemptId ? [row.latestAttemptId] : []
    )
  ),
]);
assert.ok(!allDecisionEvidenceIds.has("luna-failed-newer-attempt"));
assert.ok(!allDecisionEvidenceIds.has("legacy-attempt"));
assert.equal(
  dashboardWithEvidence.resultHistory[0]?.older[0]?.latestAttemptId,
  "luna-old-attempt"
);

const afterDelete = buildCertifiedBenchmarkDashboardData({
  resultSets: [oldSet, failedSet, solSet, invalidCompletedSet],
  ...evidence,
  caseV2: [benchmarkCase],
  attemptsV2: attempts.filter((record) => record.resultSetId !== latestSet.id),
  verifierResults: verifierResults.filter(
    (record) => record.resultSetId !== latestSet.id
  ),
  teamCompositions: [luna, sol],
  harnessCertifications: [],
});
const promoted = afterDelete.leaderboard.find((row) =>
  row.modelIds.includes("gpt-5.6-luna")
);
assert.equal(promoted?.resultSetId, "luna-old");
assert.equal(promoted?.overallDelta, null);
assert.equal(promoted?.historyCount, 0);

const bundle = {
  version: 2,
  exportedAt: completedAt,
  suites: [],
  runs,
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: [],
  failures: [],
  traces: [],
  caseV2: [benchmarkCase],
  attemptsV2: attempts,
  verifierResults,
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [luna, sol],
  harnessCertifications: [],
  resultSets,
  bundleHash: "history-bundle",
} satisfies BenchmarkReportBundleV2;
const markdown = formatBenchmarkMarkdownReport(bundle, {
  summary: {
    totalRuns: 0,
    totalCases: 0,
    capturedCases: 0,
    totalModels: 0,
    completionRate: null,
    schemaValidRate: null,
    legalActionRate: null,
    fallbackRate: null,
    averageCostUsd: null,
    averageLatencyMs: null,
  },
  models: [],
  radarRows: [],
  rateBars: [],
  costQualityPoints: [],
  latencyQualityPoints: [],
  trendRows: [],
  failureRows: [],
  headToHeadRows: [],
  evidenceByModel: {},
});
assert.match(markdown, /Latest Certified Snapshots/);
assert.match(markdown, /Certified Snapshot History/);
assert.match(markdown, /luna-new-complete/);
assert.match(markdown, /luna-old/);
assert.doesNotMatch(markdown, /luna-failed-newer-attempt/);
assert.doesNotMatch(markdown, /legacy-attempt/);
const rawJson = JSON.stringify(bundle);
assert.match(rawJson, /luna-failed-newer-attempt/);
assert.match(rawJson, /legacy-attempt/);

console.log("PASS benchmark latest history");
